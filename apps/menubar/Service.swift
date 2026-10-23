import AppKit
import Darwin

// Un servicio que la app levanta, detiene y reinicia: un proceso hijo (en su propio grupo), uno detached
// (launchd, un contenedor) o un proceso huérfano de otra instancia que se adopta.

final class Service {
    enum State { case stopped, running, stopping, starting }

    let spec: ServiceSpec
    private(set) var state: State = .stopped
    private var process: Process?
    /// pid de un proceso del servicio lanzado por otra instancia de la app (ver `processPattern`).
    private var adoptedPID: pid_t?
    private var restartAfterStop = false
    var onChange: (() -> Void)?

    init(spec: ServiceSpec, state: State = .stopped, forcedExternal: Bool? = nil) {
        self.spec = spec
        self.state = state
        self.forcedExternal = forcedExternal
    }

    /// Sólo para las capturas (`--screenshot`): fija si el puerto se ve como ocupado por otro proceso.
    private let forcedExternal: Bool?

    var isDetached: Bool { spec.stopCommand != nil }

    var logPath: String { "\(logDir)/\(spec.id).log" }

    /// Escucha en el puerto pero no lo levantamos nosotros (otra terminal, otro proceso).
    var isExternal: Bool {
        if let forcedExternal { return forcedExternal }
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
        // Aislada (IA_FLOW_MENUBAR_HOME) no adopta: los huérfanos se buscan por comando, no por carpeta, y una
        // instancia de prueba terminaría deteniendo los procesos reales. Se pide con IA_FLOW_MENUBAR_ADOPT=1.
        let env = ProcessInfo.processInfo.environment
        if env["IA_FLOW_MENUBAR_HOME"] != nil, env["IA_FLOW_MENUBAR_ADOPT"] != "1" { return }
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
    private func shellProcess(_ command: String, log: FileHandle?) -> Process {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/perl")
        p.arguments = ["-e", "use POSIX; setsid(); exec @ARGV", "/bin/zsh", "-lc", command]
        p.currentDirectoryURL = URL(fileURLWithPath: spec.cwd)
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "\(home)/.bun/bin:/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
        spec.env?.forEach { env[$0.key] = $0.value }
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

        let p = shellProcess(spec.command, log: log)
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
        if restartAfterStop {
            restartAfterStop = false
            start()
        } else {
            onChange?()
        }
    }
}
