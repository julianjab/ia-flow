import AppKit
import SwiftUI

// El estado que lee la interfaz y las acciones que dispara. Los servicios los maneja Service.swift; esto sólo
// los agrupa y publica los cambios a SwiftUI.

struct ConfirmRequest {
    let title: String
    let detail: String
    let confirmLabel: String
    var destructive = false
    let action: () -> Void
}

struct ServiceGroup: Identifiable {
    let title: String
    let services: [Service]
    var id: String { title }
}

final class AppModel: ObservableObject {
    @Published private(set) var services: [Service]
    /// La bandeja del server elegido (Para mí · En curso · Próximo), sus pantallas y su log.
    let runner: RunnerModel
    /// El chat del runner elegido, general o sobre una tarea: la caja al pie lo abre como panel encima.
    let assistant: AssistantModel
    /// El panel del asistente está abierto sobre la vista.
    @Published var assistantOpen = false
    @Published var confirm: ConfirmRequest?
    @Published var toast: String?
    /// «Deshacer» del aviso, si lo tiene.
    @Published var toastUndo: (() -> Void)?
    /// Avisa al ícono de la barra de menú (corriendo / en reposo).
    var onChange: (() -> Void)?
    /// «Abrir en una ventana» (lo resuelve la app: cierra el popover y abre la ventana).
    var onDetach: (() -> Void)?
    /// La ventana queda encima de las demás.
    @Published var floating = UserDefaults.standard.bool(forKey: "windowFloating") {
        didSet { UserDefaults.standard.set(floating, forKey: "windowFloating"); onFloating?(floating) }
    }
    var onFloating: ((Bool) -> Void)?
    let isFixture: Bool

    init(services: [Service]? = nil, runner: RunnerModel? = nil) {
        isFixture = services != nil
        self.services = services ?? loadAllSpecs().map { Service(spec: $0) }
        self.runner = runner ?? RunnerModel()
        assistant = isFixture ? AssistantModel.fixture(runner: self.runner) : AssistantModel(runner: self.runner)
        self.services.forEach(wire)
        self.runner.onAsk = { [weak self] item in self?.ask(about: item) }
        // Una tarea que nombra el asistente: el buscador con su ref.
        assistant.showTask = { [weak self] ref in
            guard let self else { return }
            self.assistantOpen = false
            self.runner.goHome()
            self.runner.searchOpen = true
            self.runner.query = ref
        }
        self.runner.toast = { [weak self] in self?.showToast($0) }
        self.runner.undoToast = { [weak self] text, undo in self?.showToast(text, undo: undo) }
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

    /// Servicios y observabilidad: lo detached sin grupo propio va a «Observabilidad».
    var groups: [ServiceGroup] {
        func title(_ s: Service) -> String { s.spec.group ?? (s.isDetached ? "Observabilidad" : "Servicios") }
        var order = ["Servicios", "Observabilidad"]
        for s in services where !order.contains(title(s)) { order.append(title(s)) }
        return order.map { name in ServiceGroup(title: name, services: services.filter { title($0) == name }) }
            .filter { !$0.services.isEmpty }
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

    /// Una vista de la bandeja (Para mí · En curso · Próximo): cierra el asistente y lo que estaba encima.
    func show(_ tab: InboxTab) {
        assistantOpen = false
        runner.goHome(tab)
    }

    /// La caja del pie: el chat como panel encima de lo que se ve.
    func openAssistant(listening: Bool = false) {
        assistantOpen = true
        assistant.appear()
        if listening, !Dictation.shared.isListening(assistant) { assistant.toggleListening() }
    }

    /// «Preguntar sobre esta tarea»: el panel del asistente con la tarea como tema («Sobre <ref> ×»).
    func ask(about item: InboxItem) {
        assistantOpen = true
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
        runInITerm("tail -n 200 -f '\(service.logPath)'")
    }

    func startAll() { services.forEach { if !$0.isExternal { $0.start() } } }
    /// Sólo reinicia lo que está corriendo: no enciende lo que se apagó a propósito.
    func restartAll() { services.filter { $0.state == .running }.forEach { $0.restart() } }
    func stopAll() { services.forEach { $0.stop() } }
    func editConfig() { NSWorkspace.shared.open(URL(fileURLWithPath: "\(configDir)/services.json")) }
    func quit() { NSApp.terminate(nil) }

    /// Con `undo`, el aviso dura más y lleva «Deshacer».
    func showToast(_ text: String, undo: (() -> Void)? = nil) {
        toast = text
        toastUndo = undo
        DispatchQueue.main.asyncAfter(deadline: .now() + (undo == nil ? 2.5 : 6)) { [weak self] in
            if self?.toast == text { self?.toast = nil; self?.toastUndo = nil }
        }
    }

    /// Datos de ejemplo para las capturas: no toca procesos, puertos ni archivos.
    static func fixture() -> AppModel {
        func spec(_ id: String, _ name: String, port: Int? = nil, url: String? = nil, detached: Bool = false) -> ServiceSpec {
            ServiceSpec(id: id, name: name, command: "", cwd: "/", port: port, url: url, env: nil, stopCommand: detached ? "true" : nil)
        }
        return AppModel(services: [
            Service(spec: spec("web", "Web", port: 5173, url: "http://localhost:5173"), state: .running),
            Service(spec: spec("gateway", "Gateway", port: 4141), state: .stopped),
            Service(spec: spec("runner", "Runner", port: 3001), state: .stopped, forcedExternal: true),
            Service(spec: spec("grafana", "Grafana (OTel)", port: 3000, url: "http://localhost:3000", detached: true), state: .running),
            Service(spec: spec("otlp-proxy", "OTLP proxy", port: 4319, detached: true), state: .running),
        ], runner: RunnerModel.fixture())
    }
}

/// Corre `command` en iTerm: en una ventana nueva o, con `tab`, en una pestaña de la ventana del frente (una ventana
/// nueva si no hay ninguna). El shell de login trae el PATH de siempre. false sin iTerm. `command` no debe traer
/// comillas dobles: va adentro de un string de AppleScript.
@discardableResult
func runInITerm(_ command: String, tab: Bool = false) -> Bool {
    guard NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.googlecode.iterm2") != nil else { return false }
    let open = tab ? """
        if (count of windows) = 0 then
            create window with default profile command "\(command)"
        else
            tell current window to create tab with default profile command "\(command)"
        end if
    """ : """
        create window with default profile command "\(command)"
    """
    let script = """
    tell application "iTerm"
        activate
    \(open)
    end tell
    """
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    p.arguments = ["-e", script]
    try? p.run()
    return true
}
