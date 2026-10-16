import Foundation

// El stream del runner (`GET /api/stream`, SSE): qué cambió, en el momento. Con el popover o la ventana abiertos, la
// bandeja se relee cuando algo cambia en vez de cada 6 s. Mismo contrato que la web (`RunnerStreamEventSchema` de
// `packages/shared`, `apps/web/src/features/inbox/stream.ts`): un `data:` en JSON por evento y `: ping` cada 25 s.
//
// Si se corta, reintenta con backoff (1 s … 30 s). Tras 3 fallas seguidas queda `failing` y la app vuelve al polling
// mientras sigue intentando; un runner anterior al stream (404) cae ahí.

/// Un evento del stream: sólo lo que el menú usa (`inbox` con sus refs, `improvements`, `trace` con su ejecución).
struct RunnerStreamEvent: Decodable {
    struct Entry: Decodable { let execution_id: String? }
    let type: String
    let refs: [String]?
    let entry: Entry?
}

extension RunnerClient {
    /// Abre el stream y entrega cada evento; `onOpen` cuando el server contestó 200. Vuelve cuando se corta.
    func stream(onOpen: @escaping () -> Void, onEvent: @escaping (RunnerStreamEvent) -> Void) async throws {
        guard let url = URL(string: server.baseUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/ ")) + "/api/stream") else {
            throw RunnerError(status: 0, message: "URL inválida: \(server.baseUrl)")
        }
        // El server manda `: ping` cada 25 s: 90 s sin nada es una conexión muerta.
        var req = URLRequest(url: url, timeoutInterval: 90)
        req.setValue("text/event-stream", forHTTPHeaderField: "accept")
        if let token = server.token, !token.isEmpty { req.setValue(token, forHTTPHeaderField: "x-ia-flow-token") }
        let (bytes, response) = try await URLSession.shared.bytes(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw RunnerError(status: status, message: "stream: HTTP \(status)") }
        onOpen()
        for try await line in bytes.lines {
            try Task.checkCancellation()
            guard line.hasPrefix("data:") else { continue }
            let json = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            if let event = try? JSONDecoder().decode(RunnerStreamEvent.self, from: Data(json.utf8)) { onEvent(event) }
        }
    }
}

/// Mantiene el stream abierto contra un server (reconecta solo) hasta `stop`. Avisa en el hilo principal.
final class RunnerStream {
    enum State: Equatable { case off, connecting, live, failing }

    private(set) var state: State = .off
    var onState: ((State) -> Void)?
    var onEvent: ((RunnerStreamEvent) -> Void)?
    private(set) var server: RunnerServer?
    private var task: Task<Void, Never>?
    private var failures = 0

    /// Tras cuántas fallas seguidas se vuelve al polling (y se sigue intentando).
    static let fallbackAfter = 3

    func start(_ server: RunnerServer) {
        if self.server == server, task != nil { return }
        stop()
        self.server = server
        failures = 0
        task = Task { [weak self] in await self?.loop(server) }
    }

    func stop() {
        task?.cancel()
        task = nil
        server = nil
        set(.off)
    }

    private func loop(_ server: RunnerServer) async {
        while !Task.isCancelled {
            set(failures >= Self.fallbackAfter ? .failing : .connecting)
            do {
                try await RunnerClient(server: server).stream(
                    onOpen: { [weak self] in
                        self?.failures = 0
                        self?.set(.live)
                    },
                    onEvent: { [weak self] event in
                        let stream = self
                        DispatchQueue.main.async { stream?.onEvent?(event) }
                    })
            } catch is CancellationError {
                return
            } catch {}
            if Task.isCancelled { return }
            failures += 1
            if failures >= Self.fallbackAfter { set(.failing) }
            // 1 s, 2 s, 4 s … hasta 30 s
            let delay = min(30, pow(2, Double(failures - 1)))
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        }
    }

    private func set(_ next: State) {
        DispatchQueue.main.async {
            // Un aviso que llega después de `stop` no reabre nada.
            guard self.state != next, next == .off || self.task != nil else { return }
            self.state = next
            self.onState?(next)
        }
    }
}
