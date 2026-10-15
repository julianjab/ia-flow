import AppKit
import SwiftUI

// El estado que lee la interfaz y las acciones que dispara. Los servicios los maneja Service.swift; esto sólo
// los agrupa, publica los cambios a SwiftUI y arma el formulario de túnel (que reemplaza a los diálogos modales).

struct ConfirmRequest {
    let title: String
    let detail: String
    let confirmLabel: String
    var destructive = false
    let action: () -> Void
}

struct TunnelForm {
    /// Lo que hay que confirmar antes de crear: exponer el puerto del runner o gateway, o pisar un DNS ajeno.
    enum Notice { case expose(Int), overwriteDNS(String) }

    var sub = ""
    var portText = ""
    var ports: [(port: Int, command: String)] = []
    var error: String?
    var notice: Notice?
    /// Lo confirmado es un puerto y un host concretos: cambiar el subdominio o el puerto invalida la confirmación.
    var okExposePort: Int?
    var okOverwriteHost: String?
    var checking = false

    /// El puerto escrito o elegido (acepta «5173» y también «5173  ·  node»).
    var port: Int? {
        Int(portText.trimmingCharacters(in: .whitespaces).prefix { $0.isNumber }).flatMap { (1...65535).contains($0) ? $0 : nil }
    }

    var cleanSub: String { sub.trimmingCharacters(in: .whitespaces).lowercased() }
}

struct ServiceGroup: Identifiable {
    let title: String
    let services: [Service]
    var id: String { title }
}

final class AppModel: ObservableObject {
    enum Tab { case services, runner, assistant }

    @Published private(set) var services: [Service]
    @Published var tab: Tab = .runner
    /// La pestaña «Runner»: la bandeja del server elegido, sus épicas y su log.
    let runner: RunnerModel
    /// La pestaña «Asistente»: el chat del runner elegido, general o sobre una tarea.
    let assistant: AssistantModel
    @Published var form: TunnelForm?
    @Published var confirm: ConfirmRequest?
    @Published var toast: String?
    /// Avisa al ícono de la barra de menú (corriendo / en reposo).
    var onChange: (() -> Void)?
    let isFixture: Bool

    init(services: [Service]? = nil, runner: RunnerModel? = nil) {
        isFixture = services != nil
        self.services = services ?? loadAllSpecs().map { Service(spec: $0) }
        self.runner = runner ?? RunnerModel()
        assistant = isFixture ? AssistantModel.fixture(runner: self.runner) : AssistantModel(runner: self.runner)
        self.services.forEach(wire)
        self.runner.onAsk = { [weak self] item in self?.ask(about: item) }
        assistant.showTask = { [weak self] ref in
            self?.runner.query = ref
            self?.runner.screen = .inbox
            self?.tab = .runner
        }
        self.runner.toast = { [weak self] in self?.showToast($0) }
        self.runner.confirm = { [weak self] in self?.confirm = $0 }
        refresh()
    }

    private func wire(_ service: Service) {
        service.onChange = { [weak self] in self?.changed() }
    }

    private func changed() {
        objectWillChange.send()
        onChange?()
    }

    var activeCount: Int { services.filter { $0.state != .stopped }.count }

    /// Servicios, observabilidad y túneles: lo detached sin grupo propio va a «Observabilidad».
    var groups: [ServiceGroup] {
        func title(_ s: Service) -> String { s.spec.group ?? (s.isDetached ? "Observabilidad" : "Servicios") }
        var order = ["Servicios", "Observabilidad", "Túneles"]
        for s in services where !order.contains(title(s)) { order.append(title(s)) }
        return order.map { name in ServiceGroup(title: name, services: services.filter { title($0) == name }) }
            .filter { !$0.services.isEmpty || $0.title == "Túneles" }
    }

    /// Relee el estado real (puertos y procesos huérfanos). Sólo con el popover abierto o al arrancar.
    func refresh() {
        guard !isFixture else { return }
        services.forEach { $0.syncFromPort() }
        changed()
    }

    // MARK: acciones sobre un servicio

    func toggle(_ service: Service) {
        switch service.state {
        case .stopped: if !service.isExternal { service.start() }
        case .running: service.stop()
        case .starting, .stopping: break
        }
    }

    func restart(_ service: Service) { service.restart() }

    func selectTab(_ tab: Tab) {
        self.tab = tab
        if tab == .runner { runner.refresh() }
        if tab == .assistant { assistant.appear() }
    }

    /// «Preguntar sobre esta tarea»: la pestaña Asistente con la tarea como tema.
    func ask(about item: InboxItem) {
        tab = .assistant
        assistant.appear()
        assistant.ask(about: item)
    }

    func openURL(_ service: Service) {
        if let url = service.spec.url.flatMap(URL.init(string:)) { NSWorkspace.shared.open(url) }
    }

    /// Abre `tail -f` del log en una ventana nueva de iTerm; sin iTerm, el log en el editor por defecto.
    func openLog(_ service: Service) {
        guard NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.googlecode.iterm2") != nil else {
            NSWorkspace.shared.open(URL(fileURLWithPath: service.logPath))
            return
        }
        if !FileManager.default.fileExists(atPath: service.logPath) {
            FileManager.default.createFile(atPath: service.logPath, contents: nil)
        }
        let script = """
        tell application "iTerm"
            activate
            create window with default profile command "tail -n 200 -f '\(service.logPath)'"
        end tell
        """
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", script]
        try? p.run()
    }

    func startAll() { services.forEach { if !$0.isExternal { $0.start() } } }
    /// Sólo reinicia lo que está corriendo: no enciende lo que se apagó a propósito (un túnel expone un puerto a internet).
    func restartAll() { services.filter { $0.state == .running }.forEach { $0.restart() } }
    func stopAll() { services.forEach { $0.stop() } }
    func editConfig() { NSWorkspace.shared.open(URL(fileURLWithPath: "\(configDir)/services.json")) }
    func quit() { NSApp.terminate(nil) }

    func showToast(_ text: String) {
        toast = text
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            if self?.toast == text { self?.toast = nil }
        }
    }

    // MARK: túneles

    private func persistTunnels() {
        // Sólo los túneles creados desde el menú; un servicio de services.json con deleteCommand no va aquí.
        save(services.map(\.spec).filter { $0.id.hasPrefix("tunnel-") && $0.deleteCommand != nil }, to: tunnelsPath)
    }

    func requestDelete(_ service: Service) {
        confirm = ConfirmRequest(
            title: "¿Borrar \(service.spec.name)?",
            detail: "Detiene el túnel, borra su registro DNS en Cloudflare (sólo el suyo, si hay token) y lo elimina de cloudflared.",
            confirmLabel: "Borrar", destructive: true
        ) { [weak self] in self?.deleteTunnel(service) }
    }

    /// Detiene el túnel y lo saca de la lista; después borra su CNAME (se encuentra por el id del túnel) y el túnel.
    private func deleteTunnel(_ service: Service) {
        let finish = { [weak self] in
            self?.services.removeAll { $0 === service }
            self?.persistTunnels()
            DispatchQueue.global().async {
                appendLog(removeTunnelDNS(sub: tunnelSub(service)), to: service.logPath)
                DispatchQueue.main.async { service.runDelete() }
            }
        }
        // Si ya se está deteniendo (`.stopping`) también se espera: borrar con cloudflared aún conectado falla.
        if service.state == .running || service.state == .stopping {
            service.afterStop = finish
            if service.state == .running { service.stop() }
        } else {
            finish()
        }
        changed()
    }

    func beginForm() {
        var f = TunnelForm()
        f.ports = listeningPorts()
        form = f
    }

    func cancelForm() { form = nil }

    /// Valida y crea el túnel. El DNS se consulta fuera del hilo principal: `dig` puede tardar unos segundos.
    func submitForm() {
        guard var f = form, !f.checking else { return }
        f.error = nil
        let sub = f.cleanSub
        guard sub.range(of: "^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$", options: .regularExpression) != nil else {
            f.error = "Subdominio inválido: sólo letras minúsculas, números y guiones."
            form = f
            return
        }
        guard let port = f.port else {
            f.error = "Puerto inválido: un número entre 1 y 65535."
            form = f
            return
        }
        let host = "\(sub).julianjab.link"
        guard !services.contains(where: { $0.spec.id == "tunnel-\(sub)" }), !hostnameInUse(host) else {
            f.error = "\(host) ya lo usa otro túnel."
            form = f
            return
        }
        if [3001, 4141].contains(port), f.okExposePort != port {
            f.notice = .expose(port)
            form = f
            return
        }
        f.checking = true
        f.notice = nil
        form = f
        DispatchQueue.global().async { [weak self] in
            let exists = dnsRecordExists(host)
            DispatchQueue.main.async { self?.finishSubmit(sub: sub, port: port, dnsExists: exists) }
        }
    }

    private func finishSubmit(sub: String, port: Int, dnsExists: Bool) {
        guard var f = form else { return }
        f.checking = false
        // Si el formulario ya no es el que se consultó (o se canceló), el resultado no vale: no se crea nada.
        guard f.cleanSub == sub, f.port == port else {
            form = f
            return
        }
        if dnsExists, f.okOverwriteHost != "\(sub).julianjab.link" {
            f.notice = .overwriteDNS("\(sub).julianjab.link")
            form = f
            return
        }
        form = nil
        let service = Service(spec: tunnelSpec(sub: sub, port: port))
        // TUNNEL_FORCE_PROVISIONING_DNS es el `-f` de `route dns`; vale sólo para este primer inicio.
        if dnsExists { service.nextStartEnv = ["TUNNEL_FORCE_PROVISIONING_DNS": "true"] }
        wire(service)
        services.append(service)
        persistTunnels()
        service.start()
        showToast("Túnel creado: \(sub).julianjab.link")
    }

    /// Datos de ejemplo para las capturas: no toca procesos, puertos ni archivos.
    static func fixture() -> AppModel {
        func spec(_ id: String, _ name: String, port: Int? = nil, url: String? = nil, group: String? = nil, detached: Bool = false, tunnel: Bool = false) -> ServiceSpec {
            ServiceSpec(id: id, name: name, command: "", cwd: "/", port: port, url: url, env: nil,
                        stopCommand: detached ? "true" : nil, group: group, deleteCommand: tunnel ? "true" : nil)
        }
        return AppModel(services: [
            Service(spec: spec("web", "Web", port: 5173, url: "http://localhost:5173"), state: .running),
            Service(spec: spec("gateway", "Gateway", port: 4141), state: .stopped),
            Service(spec: spec("runner", "Runner", port: 3001), state: .stopped, forcedExternal: true),
            Service(spec: spec("grafana", "Grafana (OTel)", port: 3000, url: "http://localhost:3000", detached: true), state: .running),
            Service(spec: spec("otlp-proxy", "OTLP proxy", port: 4319, detached: true), state: .running),
            Service(spec: spec("tunnel-demo", "demo.julianjab.link → :5173", url: "https://demo.julianjab.link", group: "Túneles", tunnel: true), state: .starting),
        ], runner: RunnerModel.fixture())
    }
}
