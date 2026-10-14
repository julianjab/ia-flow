import AppKit
import Darwin

// Barra de menú de ia-flow: levanta, detiene y reinicia web, gateway y runner.
// Sin ventanas ni Dock; un proceso nativo que sólo espera eventos (≈ 0 % CPU en reposo).

struct ServiceSpec: Codable {
    let id: String
    let name: String
    let command: String
    let cwd: String
    let port: Int?
    let url: String?
    var env: [String: String]?
    /// Con `stopCommand` el servicio es "detached": `command` lo deja corriendo por su cuenta
    /// (launchd, un contenedor) y el estado sale del puerto, no de un proceso hijo.
    var stopCommand: String?
    /// Los servicios de un mismo grupo van juntos, separados de los demás en el menú.
    var group: String?
    /// Si lo trae, el servicio se puede borrar del menú: corre esto (ej. borrar el túnel) y se olvida.
    var deleteCommand: String?
    /// Regex (pgrep -f) con la que se reconoce el proceso del servicio aunque lo haya lanzado otra
    /// instancia de la app (un túnel no abre puerto local: sin esto un huérfano se vería detenido).
    var processPattern: String?
}

// IA_FLOW_MENUBAR_HOME aísla la config, los logs y los túneles en otra carpeta (pruebas); no cambia el HOME real.
let home = ProcessInfo.processInfo.environment["IA_FLOW_MENUBAR_HOME"] ?? FileManager.default.homeDirectoryForCurrentUser.path
let configDir = "\(home)/.config/ia-flow-menubar"
let logDir = "\(home)/.local/state/ia-flow/menubar"

func defaultServices(root: String) -> [ServiceSpec] {
    [
        // IA_FLOW_ALLOWED_HOSTS: sin él vite sólo acepta localhost y un túnel de julianjab.link da 403.
        ServiceSpec(id: "web", name: "Web", command: "bun run --cwd apps/web vite build && bun run --cwd apps/web preview", cwd: root, port: 5173, url: "http://localhost:5173",
            env: ["IA_FLOW_ALLOWED_HOSTS": ".julianjab.link"], stopCommand: nil),
        ServiceSpec(id: "gateway", name: "Gateway", command: "bun run gateway", cwd: root, port: 4141, url: nil, env: nil, stopCommand: nil),
        ServiceSpec(id: "runner", name: "Runner", command: "bun run runner:serve", cwd: root, port: 3001, url: nil, env: nil, stopCommand: nil),
        // Grafana + OTel (otel-lgtm) en podman: levanta la VM si está caída y el compose del runner.
        ServiceSpec(
            id: "grafana", name: "Grafana (OTel)",
            command: "(podman machine start 2>/dev/null || true) && podman compose -f apps/runner-v2/otel/compose.yaml up -d",
            cwd: root, port: 3000, url: "http://localhost:3000", env: nil,
            stopCommand: "podman stop ia-flow-otel-lgtm"),
        // El proxy OTLP con token (:4319 → otel-lgtm :4318) ya vive como LaunchAgent: se maneja con launchctl.
        ServiceSpec(
            id: "otlp-proxy", name: "OTLP proxy",
            command: "launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/link.julianjab.otlp-proxy.plist 2>/dev/null; launchctl kickstart -k gui/$(id -u)/link.julianjab.otlp-proxy",
            cwd: home, port: 4319, url: nil, env: nil,
            stopCommand: "launchctl bootout gui/$(id -u)/link.julianjab.otlp-proxy"),
    ]
}

/// Lee `services.json`; si no existe lo crea con los defaults para que se pueda editar.
func loadServices() -> [ServiceSpec] {
    let root = (Bundle.main.object(forInfoDictionaryKey: "IAFlowRoot") as? String)
        ?? FileManager.default.currentDirectoryPath
    let path = "\(configDir)/services.json"
    if let data = FileManager.default.contents(atPath: path),
       var specs = try? JSONDecoder().decode([ServiceSpec].self, from: data) {
        // Los defaults que aparecieron después de crear el archivo se agregan una sola vez: los ids
        // ya conocidos van a `known-ids.json`, así borrar un servicio a propósito no lo resucita.
        let knownPath = "\(configDir)/known-ids.json"
        let known = Set((FileManager.default.contents(atPath: knownPath)
            .flatMap { try? JSONDecoder().decode([String].self, from: $0) }) ?? specs.map(\.id))
        let defaults = defaultServices(root: root)
        let missing = defaults.filter { !known.contains($0.id) }
        if !missing.isEmpty { specs += missing; save(specs, to: path) }
        let allKnown = known.union(defaults.map(\.id)).sorted()
        if let data = try? JSONEncoder().encode(allKnown) { FileManager.default.createFile(atPath: knownPath, contents: data) }
        return specs
    }
    let specs = defaultServices(root: root)
    save(specs, to: path)
    let ids = specs.map(\.id).sorted()
    if let data = try? JSONEncoder().encode(ids) { FileManager.default.createFile(atPath: "\(configDir)/known-ids.json", contents: data) }
    return specs
}

let tunnelsPath = "\(configDir)/tunnels.json"

/// Los túneles creados desde el menú (los que ya no se ven en `services.json`).
func loadTunnels() -> [ServiceSpec] {
    let saved = FileManager.default.contents(atPath: tunnelsPath)
        .flatMap { try? JSONDecoder().decode([ServiceSpec].self, from: $0) } ?? []
    // Los túneles guardados antes de `processPattern` lo derivan de su id (`tunnel-<sub>`).
    return saved.map { spec in
        var spec = spec
        if spec.processPattern == nil { spec.processPattern = tunnelProcessPattern(name: "menubar-\(spec.id.dropFirst("tunnel-".count))") }
        return spec
    }
}

func tunnelProcessPattern(name: String) -> String {
    "cloudflared tunnel --config .* run --url http://localhost:[0-9]+ \(name)$"
}

/// Un túnel con nombre de cloudflared a `puerto`, bajo `<sub>.julianjab.link`. Idempotente: al
/// iniciar crea el túnel y el DNS si faltan (`tunnel info` sale 0 aunque no exista: se usa `list`).
/// Sin `-f`: un registro ajeno no se pisa. Pisarlo (confirmado por la persona) es sólo del primer
/// inicio, con `Service.nextStartEnv`, para que no quede grabado en `tunnels.json`. `--config` propio (también en `route dns`) ignora el `tunnel:` del `config.yml` global de ~/.cloudflared,
/// que si no hace que el CNAME apunte al túnel viejo en vez de al nuevo.
func tunnelSpec(sub: String, port: Int) -> ServiceSpec {
    let name = "menubar-\(sub)"
    let host = "\(sub).julianjab.link"
    let config = "\(configDir)/tunnel.yml"
    return ServiceSpec(
        id: "tunnel-\(sub)", name: "\(host) → :\(port)",
        command: "echo 'no-autoupdate: true' > '\(config)'; "
            + "cloudflared tunnel list -n \(name) -o json 2>/dev/null | grep -q '\"name\"' || cloudflared tunnel create \(name) || exit 1; "
            + "cloudflared tunnel --config '\(config)' route dns \(name) \(host) 2>&1 | tail -1; "
            + "exec cloudflared tunnel --config '\(config)' run --url http://localhost:\(port) \(name)",
        cwd: home, port: nil, url: "https://\(host)", env: nil, stopCommand: nil,
        group: "Túneles",
        deleteCommand: "cloudflared tunnel cleanup \(name); cloudflared tunnel delete \(name)",
        processPattern: tunnelProcessPattern(name: name))
}

/// Puertos TCP en escucha en esta máquina (`lsof -Fcn`: líneas `c<comando>` y `n<dirección>:<puerto>`),
/// sin repetir y de menor a mayor. Es lo que se ofrece al elegir qué exponer.
func listeningPorts() -> [(port: Int, command: String)] {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
    p.arguments = ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fcn"]
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    guard (try? p.run()) != nil else { return [] }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    var command = ""
    var found: [Int: String] = [:]
    for line in String(decoding: data, as: UTF8.self).split(separator: "\n") {
        switch line.first {
        case "c": command = String(line.dropFirst())
        case "n":
            if let port = line.split(separator: ":").last.flatMap({ Int($0) }), found[port] == nil { found[port] = command }
        default: break
        }
    }
    return found.sorted { $0.key < $1.key }.map { (port: $0.key, command: $0.value) }
}

/// Zona y token de la API de Cloudflare (archivos propios de la app, el token con permisos 0600).
func cloudflareAuth() -> (zone: String, token: String)? {
    func read(_ name: String) -> String? {
        (try? String(contentsOfFile: "\(configDir)/\(name)", encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
    guard let zone = read("cloudflare-zone-id"), let token = read("cloudflare-token"),
          !zone.isEmpty, !token.isEmpty else { return nil }
    return (zone, token)
}

/// Llamada síncrona a la API de Cloudflare; el JSON de la respuesta o nil si falla.
func cloudflareRequest(_ method: String, _ path: String, token: String) -> [String: Any]? {
    guard let url = URL(string: "https://api.cloudflare.com/client/v4\(path)") else { return nil }
    var request = URLRequest(url: url, timeoutInterval: 10)
    request.httpMethod = method
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    var result: [String: Any]?
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: request) { data, _, _ in
        result = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        done.signal()
    }.resume()
    _ = done.wait(timeout: .now() + 12)
    return result
}

/// El id del túnel de cloudflared con ese nombre (`tunnel list -n … -o json`).
func cloudflaredTunnelID(_ name: String) -> String? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/zsh")
    p.arguments = ["-lc", "cloudflared tunnel list -n \(name) -o json 2>/dev/null"]
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
    p.environment = env
    guard (try? p.run()) != nil else { return nil }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    return (try? JSONSerialization.jsonObject(with: data) as? [[String: Any]])?.first?["id"] as? String
}

/// Borra el CNAME de `<sub>.julianjab.link` SÓLO si apunta al túnel `menubar-<sub>`
/// (`<id>.cfargotunnel.com`): un registro de otro túnel o servicio no se toca. Devuelve qué pasó.
func removeTunnelDNS(sub: String) -> String {
    guard let auth = cloudflareAuth() else {
        return "[menubar] sin token de Cloudflare: el registro DNS de \(sub).julianjab.link queda"
    }
    guard let id = cloudflaredTunnelID("menubar-\(sub)") else {
        return "[menubar] no encontré el túnel menubar-\(sub): no sé qué registro borrar"
    }
    let host = "\(sub).julianjab.link"
    let query = "/zones/\(auth.zone)/dns_records?type=CNAME&name=\(host)"
    guard let listed = cloudflareRequest("GET", query, token: auth.token),
          listed["success"] as? Bool == true, let records = listed["result"] as? [[String: Any]] else {
        return "[menubar] no pude consultar el DNS de \(host) (¿token sin permiso DNS:Edit en la zona?)"
    }
    let own = records.filter { ($0["content"] as? String) == "\(id).cfargotunnel.com" }
    guard !own.isEmpty else { return "[menubar] \(host) no tiene un registro de este túnel: no borré nada" }
    var deleted = 0
    for record in own {
        guard let recordID = record["id"] as? String,
              let response = cloudflareRequest("DELETE", "/zones/\(auth.zone)/dns_records/\(recordID)", token: auth.token),
              response["success"] as? Bool == true else { continue }
        deleted += 1
    }
    return "[menubar] DNS de \(host) borrado (\(deleted)/\(own.count))"
}

func appendLog(_ message: String, to path: String) {
    guard let handle = FileHandle(forWritingAtPath: path) else { return }
    handle.seekToEndOfFile()
    handle.write(Data("\n\(message)\n".utf8))
    try? handle.close()
}

/// El subdominio de un túnel creado desde el menú (su id es `tunnel-<sub>`).
func tunnelSub(_ service: Service) -> String { String(service.spec.id.dropFirst("tunnel-".count)) }

/// ¿Ese hostname ya resuelve? (Cloudflare aplana el CNAME: se mira cualquier registro.)
func dnsRecordExists(_ host: String) -> Bool {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/dig")
    p.arguments = ["+short", "+time=3", "+tries=1", host]
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    guard (try? p.run()) != nil else { return false }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    // Un timeout hace que dig imprima `;; …` y salga distinto de 0: eso no es un registro.
    guard p.terminationStatus == 0 else { return false }
    return String(decoding: data, as: UTF8.self).split(separator: "\n").contains { !$0.hasPrefix(";;") && !$0.isEmpty }
}

func save(_ specs: [ServiceSpec], to path: String) {
    try? FileManager.default.createDirectory(atPath: configDir, withIntermediateDirectories: true)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    if let data = try? encoder.encode(specs) { FileManager.default.createFile(atPath: path, contents: data) }
}

/// ¿Hay algo escuchando en localhost:port? Prueba IPv4 y IPv6: vite y otros escuchan sólo en `::1`.
func portIsOpen(_ port: Int) -> Bool {
    func connects(family: Int32, address: UnsafeRawPointer, size: Int) -> Bool {
        let fd = socket(family, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        return connect(fd, address.assumingMemoryBound(to: sockaddr.self), socklen_t(size)) == 0
    }
    var v4 = sockaddr_in()
    v4.sin_family = sa_family_t(AF_INET)
    v4.sin_port = in_port_t(port).bigEndian
    v4.sin_addr.s_addr = inet_addr("127.0.0.1")
    if connects(family: AF_INET, address: &v4, size: MemoryLayout<sockaddr_in>.size) { return true }
    var v6 = sockaddr_in6()
    v6.sin6_family = sa_family_t(AF_INET6)
    v6.sin6_port = in_port_t(port).bigEndian
    v6.sin6_addr = in6addr_loopback
    return connects(family: AF_INET6, address: &v6, size: MemoryLayout<sockaddr_in6>.size)
}

/// Escapa los metacaracteres de una regex extendida (pgrep -f) para buscar un texto literal.
func escapedForERE(_ text: String) -> String {
    var out = ""
    for ch in text {
        if "\\.[]{}()*+?|^$".contains(ch) { out.append("\\") }
        out.append(ch)
    }
    return out
}

final class Service {
    enum State { case stopped, running, stopping, starting }

    let spec: ServiceSpec
    private(set) var state: State = .stopped
    private var process: Process?
    /// pid de un proceso del servicio lanzado por otra instancia de la app (ver `processPattern`).
    private var adoptedPID: pid_t?
    private var restartAfterStop = false
    var onChange: (() -> Void)?
    /// Se corre una vez cuando el proceso termina (borrar un túnel espera a que cierre).
    var afterStop: (() -> Void)?
    /// Variables de entorno extra para el PRÓXIMO inicio y nada más (no se persisten).
    var nextStartEnv: [String: String] = [:]

    init(spec: ServiceSpec) { self.spec = spec }

    var isDetached: Bool { spec.stopCommand != nil }

    var logPath: String { "\(logDir)/\(spec.id).log" }

    /// Escucha en el puerto pero no lo levantamos nosotros (otra terminal, otro proceso).
    var isExternal: Bool {
        guard state == .stopped, let port = spec.port else { return false }
        return portIsOpen(port)
    }

    /// Cómo se reconoce el proceso del servicio: el `processPattern` de la spec o, si no, su comando
    /// (con o sin el `zsh -lc` que lo envuelve, según si zsh lo reemplazó por `exec`).
    private var matchPattern: String? {
        if let pattern = spec.processPattern { return pattern }
        if isDetached { return nil }
        // zsh -c reemplaza el shell por el ÚLTIMO comando de una cadena `a && b`: el proceso líder puede
        // verse sólo como `b`. Se acepta el comando completo o su último tramo.
        let last = spec.command.components(separatedBy: "&&").last?.trimmingCharacters(in: .whitespaces) ?? spec.command
        let options = Set([spec.command, last]).map(escapedForERE).joined(separator: "|")
        return "(^|/bin/zsh -lc )(\(options))$"
    }

    /// Sólo se adopta lo huérfano (padre = launchd, pid 1) y líder de su grupo: es lo que dejó una
    /// instancia anterior de la app. Un proceso lanzado a mano desde una terminal tiene a su shell de padre.
    private func isOrphanGroupLeader(_ pid: pid_t) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/ps")
        p.arguments = ["-o", "ppid=,pgid=", "-p", "\(pid)"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return false }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        let fields = String(decoding: data, as: UTF8.self).split(whereSeparator: \.isWhitespace).compactMap { Int($0) }
        return fields.count == 2 && fields[0] == 1 && fields[1] == Int(pid)
    }

    /// Un proceso del servicio que no lanzó esta instancia (p. ej. tras reabrir la app) se adopta como
    /// «corriendo» para poder verlo y detenerlo; si ya no está, vuelve a «detenido».
    private func syncAdopted() {
        guard let pattern = matchPattern, process == nil, state == .stopped || adoptedPID != nil,
              state != .stopping else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        p.arguments = ["-f", pattern]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        let pid = String(decoding: data, as: UTF8.self).split(separator: "\n").compactMap { pid_t($0) }
            .filter(isOrphanGroupLeader).min()
        if let pid {
            adoptedPID = pid
            state = .running
        } else if adoptedPID != nil {
            adoptedPID = nil
            state = .stopped
        }
    }

    /// Detiene un proceso adoptado: SIGTERM a su grupo y, si no cae en 5 s, SIGKILL.
    private func stopAdopted(_ pid: pid_t) {
        state = .stopping
        kill(-pid, SIGTERM)
        kill(pid, SIGTERM)
        onChange?()
        func wait(_ attempts: Int) {
            if kill(pid, 0) != 0 || attempts == 0 {
                if kill(pid, 0) == 0 { kill(-pid, SIGKILL); kill(pid, SIGKILL) }
                adoptedPID = nil
                didExit()
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { wait(attempts - 1) }
        }
        wait(10)
    }

    /// Servicios detached: el estado es lo que diga el puerto (salvo mientras corre un comando).
    func syncFromPort() {
        if !isDetached { return syncAdopted() }
        guard isDetached, state != .starting, state != .stopping, let port = spec.port else { return }
        state = portIsOpen(port) ? .running : .stopped
    }

    /// Corre `command` hasta que termine, y sondea el puerto hasta que llegue al estado esperado.
    private func runDetached(_ command: String, becoming target: State, restartAfter: Bool = false) {
        state = target == .running ? .starting : .stopping
        onChange?()
        try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: logPath, contents: nil)
        let log = FileHandle(forWritingAtPath: logPath)
        let p = shellProcess(command, log: log)
        p.terminationHandler = { [weak self] finished in
            let status = finished.terminationStatus
            DispatchQueue.main.async {
                guard let self else { return }
                if status != 0 {
                    // El comando falló: no se espera al puerto ni se relanza; el estado es el real.
                    log?.write(Data("\n[menubar] el comando salió con código \(status)\n".utf8))
                    self.state = .stopped
                    self.syncFromPort()
                    self.onChange?()
                    return
                }
                self.pollPort(until: target, attemptsLeft: 90, restartAfter: restartAfter)
            }
        }
        do { try p.run() } catch {
            log?.write(Data("no arrancó: \(error)\n".utf8))
            state = .stopped
            onChange?()
        }
    }

    private func pollPort(until target: State, attemptsLeft: Int, restartAfter: Bool) {
        let isUp = spec.port.map(portIsOpen) ?? (target == .running)
        if isUp == (target == .running) || attemptsLeft == 0 {
            state = isUp ? .running : .stopped
            onChange?()
            if restartAfter { runDetached(spec.command, becoming: .running) }
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            self?.pollPort(until: target, attemptsLeft: attemptsLeft - 1, restartAfter: restartAfter)
        }
    }

    /// `zsh -lc` con el PATH del usuario; `setsid` para que `kill(-pid)` baje a todo el grupo.
    private func shellProcess(_ command: String, log: FileHandle?, extraEnv: [String: String] = [:]) -> Process {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/perl")
        p.arguments = ["-e", "use POSIX; setsid(); exec @ARGV", "/bin/zsh", "-lc", command]
        p.currentDirectoryURL = URL(fileURLWithPath: spec.cwd)
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "\(home)/.bun/bin:/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
        spec.env?.forEach { env[$0.key] = $0.value }
        extraEnv.forEach { env[$0.key] = $0.value }
        p.environment = env
        p.standardOutput = log
        p.standardError = log
        p.standardInput = FileHandle.nullDevice
        return p
    }

    func start() {
        guard state == .stopped else { return }
        if isDetached { return runDetached(spec.command, becoming: .running) }
        try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: logPath, contents: nil)
        let log = FileHandle(forWritingAtPath: logPath)

        let p = shellProcess(spec.command, log: log, extraEnv: nextStartEnv)
        nextStartEnv = [:]
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.didExit() }
        }
        do {
            try p.run()
            process = p
            state = .running
        } catch {
            log?.write(Data("no arrancó: \(error)\n".utf8))
        }
        onChange?()
    }

    func stop() {
        if let stopCommand = spec.stopCommand {
            if state == .running { runDetached(stopCommand, becoming: .stopped) }
            return
        }
        if state == .running, process == nil, let pid = adoptedPID { return stopAdopted(pid) }
        guard state == .running, let p = process else { return }
        state = .stopping
        kill(-p.processIdentifier, SIGTERM)
        // Si no cae en 5 s, SIGKILL al grupo.
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            guard let self, self.state == .stopping, let p = self.process else { return }
            kill(-p.processIdentifier, SIGKILL)
        }
        onChange?()
    }

    /// Corre `deleteCommand` (suelto: su salida va al log del servicio).
    func runDelete() {
        guard let command = spec.deleteCommand else { return }
        let log = FileHandle(forWritingAtPath: logPath)
        try? shellProcess(command, log: log).run()
    }

    func restart() {
        if isDetached, state == .running, let stopCommand = spec.stopCommand {
            return runDetached(stopCommand, becoming: .stopped, restartAfter: true)
        }
        switch state {
        case .stopped: start()
        case .running: restartAfterStop = true; stop()
        case .stopping: restartAfterStop = true
        case .starting: break
        }
    }

    private func didExit() {
        process = nil
        state = .stopped
        if let afterStop {
            self.afterStop = nil
            afterStop()
            onChange?()
        } else if restartAfterStop {
            restartAfterStop = false
            start()
        } else {
            onChange?()
        }
    }
}

// Glifo de la barra de menú: un pipeline de tres nodos (refine → build → review) unidos por un conector
// en S. Reposo: nodos huecos; algo corriendo: nodos llenos. Template: macOS lo tiñe según el tema.
private func flowIcon(running: Bool) -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
        let nodes = [NSPoint(x: 3, y: 3), NSPoint(x: 9, y: 9), NSPoint(x: 15, y: 15)]
        let radius: CGFloat = 2.5
        let line: CGFloat = 1.3
        let circles = nodes.map { NSBezierPath(ovalIn: NSRect(x: $0.x - radius, y: $0.y - radius, width: radius * 2, height: radius * 2)) }

        let link = NSBezierPath()
        link.move(to: nodes[0])
        link.curve(to: nodes[1], controlPoint1: NSPoint(x: 8, y: 3), controlPoint2: NSPoint(x: 9, y: 4.5))
        link.curve(to: nodes[2], controlPoint1: NSPoint(x: 9, y: 13.5), controlPoint2: NSPoint(x: 10, y: 15))
        link.lineWidth = line
        link.lineCapStyle = .round

        NSColor.black.set()
        NSGraphicsContext.saveGraphicsState()
        // El conector no entra en los nodos: se recorta un poco dentro de cada aro para que no quede costura.
        let clip = NSBezierPath(rect: NSRect(x: 0, y: 0, width: 18, height: 18))
        circles.forEach { clip.append(NSBezierPath(ovalIn: $0.bounds.insetBy(dx: line / 2, dy: line / 2))) }
        clip.windingRule = .evenOdd
        clip.addClip()
        link.stroke()
        NSGraphicsContext.restoreGraphicsState()

        for circle in circles {
            if running {
                circle.fill()
            } else {
                let ring = NSBezierPath(ovalIn: circle.bounds.insetBy(dx: line / 2, dy: line / 2))
                ring.lineWidth = line
                ring.stroke()
            }
        }
        return true
    }
    image.isTemplate = true
    image.accessibilityDescription = "ia-flow"
    return image
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private var services = (loadServices() + loadTunnels()).map(Service.init)
    private let menu = NSMenu()
    private var signalSources: [DispatchSourceSignal] = []
    private static let idleIcon = flowIcon(running: false)
    private static let runningIcon = flowIcon(running: true)

    func applicationDidFinishLaunching(_ notification: Notification) {
        menu.delegate = self
        statusItem.menu = menu
        // pkill, kill, cerrar sesión: pasan por el mismo cierre que «Salir» y detienen lo que levantó la app.
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { NSApp.terminate(nil) }
            source.resume()
            signalSources.append(source)
        }
        services.forEach { $0.onChange = { [weak self] in self?.refreshIcon() } }
        services.forEach { $0.syncFromPort() }
        refreshIcon()
    }

    func applicationWillTerminate(_ notification: Notification) {
        services.filter { !$0.isDetached }.forEach { $0.stop() }
        // Dar un respiro a los SIGTERM antes de salir.
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
    }

    private func refreshIcon() {
        let anyRunning = services.contains { $0.state != .stopped }
        statusItem.button?.image = anyRunning ? Self.runningIcon : Self.idleIcon
    }

    // El menú se reconstruye al abrirlo: así el estado (y el sondeo de puertos) está fresco.
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        services.forEach { $0.syncFromPort() }
        refreshIcon()
        var previousGroup: String?
        for service in services {
            if service.spec.group != previousGroup { menu.addItem(.separator()) }
            previousGroup = service.spec.group
            menu.addItem(item(for: service))
        }
        menu.addItem(.separator())
        menu.addItem(action("Nuevo túnel…", #selector(newTunnel)))
        menu.addItem(.separator())
        menu.addItem(action("Iniciar todo", #selector(startAll)))
        menu.addItem(action("Reiniciar todo", #selector(restartAll)))
        menu.addItem(action("Detener todo", #selector(stopAll)))
        menu.addItem(.separator())
        menu.addItem(action("Editar servicios…", #selector(editConfig)))
        menu.addItem(action("Salir (detiene los procesos que levantó)", #selector(quit), key: "q"))
    }

    private func item(for service: Service) -> NSMenuItem {
        let external = service.isExternal
        let (dot, color): (String, NSColor) = switch service.state {
        case .running: ("●", .systemGreen)
        case .stopping, .starting: ("●", .systemOrange)
        case .stopped: external ? ("●", .systemYellow) : ("○", .secondaryLabelColor)
        }
        var title = "\(dot)  \(service.spec.name)"
        if let port = service.spec.port { title += "  :\(port)" }
        if external { title += "  (externo)" }
        let parent = NSMenuItem()
        parent.attributedTitle = NSMutableAttributedString(string: title).then {
            $0.addAttribute(.foregroundColor, value: color, range: NSRange(location: 0, length: 1))
        }
        let sub = NSMenu()
        let running = service.state == .running
        sub.addItem(action("Iniciar", #selector(serviceAction(_:)), service: service, verb: "start", enabled: service.state == .stopped && !external))
        sub.addItem(action("Reiniciar", #selector(serviceAction(_:)), service: service, verb: "restart", enabled: service.state == .running))
        sub.addItem(action("Detener", #selector(serviceAction(_:)), service: service, verb: "stop", enabled: running))
        sub.addItem(.separator())
        if service.spec.url != nil {
            sub.addItem(action("Abrir en el navegador", #selector(serviceAction(_:)), service: service, verb: "open"))
        }
        sub.addItem(action("Ver log", #selector(serviceAction(_:)), service: service, verb: "log"))
        if service.spec.deleteCommand != nil {
            sub.addItem(.separator())
            sub.addItem(action("Borrar túnel", #selector(serviceAction(_:)), service: service, verb: "delete"))
        }
        parent.submenu = sub
        return parent
    }

    private func action(_ title: String, _ selector: Selector, key: String = "", service: Service? = nil, verb: String? = nil, enabled: Bool = true) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
        item.target = self
        item.isEnabled = enabled
        if let service, let verb { item.representedObject = [service, verb] as [Any] }
        return item
    }

    @objc private func serviceAction(_ sender: NSMenuItem) {
        guard let pair = sender.representedObject as? [Any],
              let service = pair[0] as? Service, let verb = pair[1] as? String else { return }
        switch verb {
        case "start": service.start()
        case "stop": service.stop()
        case "restart": service.restart()
        case "open": if let url = service.spec.url.flatMap(URL.init(string:)) { NSWorkspace.shared.open(url) }
        case "log": openLogInITerm(service)
        case "delete": deleteTunnel(service)
        default: break
        }
    }

    /// Abre `tail -f` del log en una ventana nueva de iTerm; sin iTerm, el log en el editor por defecto.
    private func openLogInITerm(_ service: Service) {
        guard NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.googlecode.iterm2") != nil else {
            NSWorkspace.shared.open(URL(fileURLWithPath: service.logPath))
            return
        }
        if !FileManager.default.fileExists(atPath: service.logPath) {
            FileManager.default.createFile(atPath: service.logPath, contents: nil)
        }
        let command = "tail -n 200 -f '\(service.logPath)'"
        let script = """
        tell application "iTerm"
            activate
            create window with default profile command "\(command)"
        end tell
        """
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", script]
        try? p.run()
    }

    private func persistTunnels() {
        save(services.map(\.spec).filter { $0.deleteCommand != nil }, to: tunnelsPath)
    }

    private func alert(_ title: String, _ detail: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = detail
        NSApp.activate(ignoringOtherApps: true)
        a.runModal()
    }

    /// Pide subdominio y puerto, crea el túnel (efímero: muere al salir de la app) y lo inicia.
    @objc private func newTunnel() {
        let sub = NSTextField(frame: NSRect(x: 0, y: 32, width: 260, height: 24))
        sub.placeholderString = "subdominio (ej. demo)"
        // Combo editable: elegís uno de los puertos en escucha o escribís el número.
        let port = NSComboBox(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        port.placeholderString = "puerto local (elige o escribe)"
        port.completes = false
        port.numberOfVisibleItems = 12
        port.addItems(withObjectValues: listeningPorts().map { "\($0.port)  ·  \($0.command)" })
        let form = NSView(frame: NSRect(x: 0, y: 0, width: 260, height: 56))
        form.addSubview(sub)
        form.addSubview(port)
        let ask = NSAlert()
        ask.messageText = "Nuevo túnel"
        ask.informativeText = "Expone un puerto local en https://<subdominio>.julianjab.link, SIN autenticación."
        ask.accessoryView = form
        ask.addButton(withTitle: "Crear y abrir")
        ask.addButton(withTitle: "Cancelar")
        NSApp.activate(ignoringOtherApps: true)
        guard ask.runModal() == .alertFirstButtonReturn else { return }

        let name = sub.stringValue.trimmingCharacters(in: .whitespaces).lowercased()
        guard name.range(of: "^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$", options: .regularExpression) != nil else {
            return alert("Subdominio inválido", "Sólo letras minúsculas, números y guiones.")
        }
        guard let number = Int(port.stringValue.trimmingCharacters(in: .whitespaces).prefix { $0.isNumber }), (1...65535).contains(number) else {
            return alert("Puerto inválido", "Un número entre 1 y 65535.")
        }
        guard !services.contains(where: { $0.spec.id == "tunnel-\(name)" }), !hostnameInUse("\(name).julianjab.link") else {
            return alert("Ese subdominio ya existe", "\(name).julianjab.link ya lo usa otro túnel.")
        }
        if [3001, 4141].contains(number) {
            let sure = NSAlert()
            sure.messageText = "¿Exponer el puerto \(number)?"
            sure.informativeText = "Es el runner o el gateway: quedan abiertos a internet sin autenticación."
            sure.addButton(withTitle: "Cancelar")
            sure.addButton(withTitle: "Exponer igual")
            guard sure.runModal() == .alertSecondButtonReturn else { return }
        }
        var overwriteDNS = false
        if dnsRecordExists("\(name).julianjab.link") {
            let conflict = NSAlert()
            conflict.messageText = "\(name).julianjab.link ya tiene un registro DNS"
            conflict.informativeText = "Apunta a otro túnel o servicio. Si lo reapuntas a este túnel nuevo, lo de antes deja de responder ahí."
            conflict.addButton(withTitle: "Cancelar")
            conflict.addButton(withTitle: "Reapuntar")
            guard conflict.runModal() == .alertSecondButtonReturn else { return }
            overwriteDNS = true
        }
        let service = Service(spec: tunnelSpec(sub: name, port: number))
        // TUNNEL_FORCE_PROVISIONING_DNS es el `-f` de `route dns`; vale sólo para este primer inicio.
        if overwriteDNS { service.nextStartEnv = ["TUNNEL_FORCE_PROVISIONING_DNS": "true"] }
        service.onChange = { [weak self] in self?.refreshIcon() }
        services.append(service)
        persistTunnels()
        service.start()
    }

    /// ¿Algún túnel de ~/.cloudflared (los de siempre) ya sirve ese hostname?
    private func hostnameInUse(_ host: String) -> Bool {
        let dir = "\(home)/.cloudflared"
        let files = (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
        return files.filter { $0.hasSuffix(".yml") }.contains {
            (try? String(contentsOfFile: "\(dir)/\($0)", encoding: .utf8))?.contains("hostname: \(host)") == true
        }
    }

    /// Detiene el túnel, borra el túnel de cloudflared y lo saca del menú. El CNAME en Cloudflare queda.
    private func deleteTunnel(_ service: Service) {
        let finish = { [weak self] in
            self?.services.removeAll { $0 === service }
            self?.persistTunnels()
            // El DNS se borra antes que el túnel: se encuentra por el id del túnel.
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
    }

    @objc private func startAll() { services.forEach { if !$0.isExternal { $0.start() } } }
    @objc private func restartAll() { services.forEach { $0.restart() } }
    @objc private func stopAll() { services.forEach { $0.stop() } }
    @objc private func editConfig() { NSWorkspace.shared.open(URL(fileURLWithPath: "\(configDir)/services.json")) }
    @objc private func quit() { NSApp.terminate(nil) }
}

extension NSMutableAttributedString {
    func then(_ body: (NSMutableAttributedString) -> Void) -> NSMutableAttributedString { body(self); return self }
}

// `--status`: imprime el estado de cada servicio y sale (para comprobar sin abrir el menú).
if CommandLine.arguments.contains("--status") {
    for spec in loadServices() + loadTunnels() {
        let service = Service(spec: spec)
        service.syncFromPort()
        print("\(spec.id)\t\(service.state)\(service.isExternal ? " (externo)" : "")")
    }
    exit(0)
}

// Una sola instancia: launchd lanza el binario directo (sin LaunchServices) y podrían quedar dos íconos.
// Con IA_FLOW_MENUBAR_HOME (pruebas aisladas) no aplica.
if ProcessInfo.processInfo.environment["IA_FLOW_MENUBAR_HOME"] == nil, let id = Bundle.main.bundleIdentifier,
   NSRunningApplication.runningApplications(withBundleIdentifier: id).contains(where: { $0.processIdentifier != getpid() }) {
    exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
