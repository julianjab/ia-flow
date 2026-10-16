import AVFoundation
import SwiftUI

// La pestaña «Asistente»: de qué se habla (todo el runner o una tarea), los turnos con lo que propone el asistente
// y las tareas que menciona, y el campo para preguntar. Sólo dibuja lo que publica AssistantModel.

struct AssistantScreen: View {
    @ObservedObject var chat: AssistantModel
    @ObservedObject var runner: RunnerModel

    var body: some View {
        VStack(spacing: 0) {
            header.padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 8)
            if chat.available == false {
                Banner(text: "\(runner.selected.name) no tiene el asistente configurado.", tone: .neutral, icon: "bubble.left")
                    .padding(.horizontal, 14).padding(.bottom, 12)
            } else {
                if runner.github == nil, runner.login == nil {
                    Banner(text: "Sin login de GitHub el asistente contesta, pero la conversación no se guarda ni puedes ejecutar lo que propone.",
                           tone: .info, icon: "person.badge.key.fill") {
                        Button("Iniciar sesión con GitHub") { runner.beginLogin() }.buttonStyle(PillButtonStyle(prominent: true, compact: true)).fixedSize()
                    }
                    .padding(.horizontal, 14).padding(.bottom, 8)
                } else if let login = runner.login {
                    DeviceLoginCard(runner: runner, login: login).padding(.horizontal, 14).padding(.bottom, 8)
                }
                thread
                Divider().opacity(0.5)
                ChatComposer(chat: chat, placeholder: chat.scope.ref == nil ? "Pregunta sobre el runner…" : "Pregunta sobre esta tarea…")
                    .padding(.horizontal, 14).padding(.vertical, 10)
            }
        }
        .onAppear { chat.appear() }
    }

    // MARK: encabezado: el tema y las conversaciones

    private var header: some View {
        HStack(spacing: 8) {
            if let ref = chat.scope.ref {
                HStack(spacing: 6) {
                    refTag(ref)
                    Text(chat.scopeTitle ?? "Esta tarea").font(.lh(12.5, .semibold)).lineLimit(1)
                    Button { chat.toGeneral() } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary) }
                        .buttonStyle(.plain).help("Preguntar sobre todo el runner")
                }
            } else {
                Label("Todo el runner", systemImage: "square.grid.2x2").font(.lh(12.5, .semibold)).foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            if !chat.history.isEmpty {
                Menu {
                    ForEach(chat.history) { summary in
                        Button {
                            chat.resume(summary)
                        } label: {
                            Text("\(summary.title) · \(ago(summary.updated_at) ?? "")")
                        }
                    }
                } label: {
                    HStack(spacing: 3) {
                        Image(systemName: "clock.arrow.circlepath").font(.system(size: 10.5, weight: .semibold))
                        Text("\(chat.history.count)").font(.lh(11, .semibold))
                    }
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .foregroundStyle(.secondary)
                    .background(Capsule().fill(Color.primary.opacity(0.07)))
                }
                .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
                .help("Conversaciones anteriores sobre esto")
            }
            IconButton(symbol: "square.and.pencil", help: "Conversación nueva") { chat.reset() }
        }
    }

    // MARK: los turnos

    private var thread: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if chat.turns.isEmpty { suggestions }
                    ForEach(chat.turns) { turn in TurnView(chat: chat, turn: turn).id(turn.id) }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 14).padding(.vertical, 8)
            }
            .scrollHeight(popoverMaxScroll - 40)
            .onChange(of: chat.turns.last?.text) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
            .onChange(of: chat.turns.count) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }

    private var suggestions: some View {
        let questions = chat.scope.ref == nil
            ? ["¿Qué me falta decidir hoy?", "¿Qué se trabó y por qué?", "¿Cómo va cada épica?"]
            : ["¿Por qué está así?", "¿Qué le falta para terminar?", "Resume lo que hizo el agente"]
        return VStack(alignment: .leading, spacing: 8) {
            Text(chat.scope.ref == nil ? "Pregúntale al asistente del runner sobre las tareas, las épicas o lo que corre."
                                       : "Pregúntale sobre esta tarea: lee su issue, sus corridas y su PR.")
                .font(.lh(12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            FlowLayout {
                ForEach(questions, id: \.self) { q in
                    SelectChip(label: q, selected: false) { chat.input = q; chat.send() }
                }
            }
        }
        .padding(.top, 6)
    }
}

/// El campo para preguntar: ↩ envía; mientras responde, el botón corta la respuesta. Arriba, la voz (vale para todos los
/// chats): «Leer en voz alta» lee cada respuesta al terminar, «Charla» además vuelve a escuchar, y la voz con la que
/// se lee. El micrófono dicta la pregunta.
struct ChatComposer: View {
    @ObservedObject var chat: AssistantModel
    let placeholder: String
    @ObservedObject private var voice = ReadAloud.shared
    @ObservedObject private var dictation = Dictation.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            voiceBar
            row
            if dictation.isListening(chat) {
                Label("Escuchando · termina con «enviar» o quédate callado 4 s para mandarla", systemImage: "waveform")
                    .font(.lh(11)).foregroundStyle(.secondary)
            } else if let error = dictation.error {
                Label(error, systemImage: "mic.slash").font(.lh(11)).foregroundStyle(.secondary)
            }
        }
    }

    private var voiceBar: some View {
        HStack(spacing: 6) {
            VoiceChip(label: "Leer en voz alta", symbol: voice.enabled ? "speaker.wave.2.fill" : "speaker.slash",
                      on: voice.enabled, help: "Lee cada respuesta al terminar (un resumen hablado)") { voice.enabled.toggle() }
            VoiceChip(label: "Charla", symbol: "bubble.left.and.bubble.right", on: voice.talk,
                      help: "Hablás, lee la respuesta y vuelve a escucharte. Callarte 4 s sin decir nada la corta.") { chat.toggleTalk() }
            Spacer(minLength: 4)
            if voice.wantsSpeech, voice.voices.count > 1 {
                Menu {
                    ForEach(voice.voices, id: \.identifier) { v in
                        Button { voice.voiceId = v.identifier } label: {
                            if v.identifier == voice.voice?.identifier {
                                Label(VoiceChip.name(of: v), systemImage: "checkmark")
                            } else {
                                Text(VoiceChip.name(of: v))
                            }
                        }
                    }
                } label: {
                    Text(voice.voice.map(VoiceChip.name(of:)) ?? "Voz").font(.lh(11)).foregroundStyle(.secondary).lineLimit(1)
                }
                .menuStyle(.button).buttonStyle(.plain).fixedSize()
                .help("Con qué voz se lee. Las Premium y Mejoradas se bajan en Ajustes › Accesibilidad › Contenido leído.")
            }
        }
    }

    private var row: some View {
        HStack(alignment: .bottom, spacing: 8) {
            FieldBox {
                TextField(placeholder, text: $chat.input, axis: .vertical)
                    .lineLimit(1...5)
                    .onSubmit { chat.send() }
                    .disabled(chat.streaming)
            }
            let listening = dictation.isListening(chat)
            IconButton(symbol: listening ? "mic.fill" : "mic",
                       help: listening ? "Dejar de dictar" : "Dictar la pregunta (termina con «enviar» o quédate callado 4 s)",
                       tint: listening ? .red : .secondary) { chat.toggleListening() }
                .padding(.bottom, 2)
            if chat.streaming {
                Button { chat.stop() } label: { Image(systemName: "stop.fill").font(.system(size: 11, weight: .bold)).frame(width: 30, height: 30) }
                    .buttonStyle(.plain).foregroundStyle(.white).background(Circle().fill(Color.red)).help("Detener la respuesta")
            } else {
                let empty = chat.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                Button { chat.send() } label: { Image(systemName: "arrow.up").font(.system(size: 12, weight: .bold)).frame(width: 30, height: 30) }
                    .buttonStyle(.plain).foregroundStyle(.white).background(Circle().fill(Color.accentColor.opacity(empty ? 0.35 : 1)))
                    .disabled(empty).help("Enviar (↩)")
            }
        }
    }
}

/// Un interruptor de la voz con su nombre a la vista: ícono + texto, resaltado cuando está prendido.
struct VoiceChip: View {
    let label: String
    let symbol: String
    let on: Bool
    let help: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(label, systemImage: symbol).font(.lh(11, .semibold)).lineLimit(1)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .foregroundStyle(on ? Color.white : Color.primary.opacity(0.7))
                .background(Capsule().fill(on ? Color.accentColor : Color.primary.opacity(0.07)))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain).help(help)
    }

    /// «Mónica · Premium»: el nombre y, si es mejor que la de serie, su calidad.
    static func name(of voice: AVSpeechSynthesisVoice) -> String {
        switch voice.quality {
        case .premium: return "\(voice.name) · Premium"
        case .enhanced: return "\(voice.name) · Mejorada"
        default: return voice.name
        }
    }
}

/// Un turno: la pregunta (a la derecha), la respuesta con su markdown, lo que propone y las tareas que menciona, o
/// una nota del menú.
struct TurnView: View {
    @ObservedObject var chat: AssistantModel
    let turn: ChatTurn

    var body: some View {
        switch turn.role {
        case .user:
            HStack {
                Spacer(minLength: 40)
                Text(turn.text).font(.lh(12.5)).textSelection(.enabled)
                    .padding(.horizontal, 11).padding(.vertical, 7)
                    .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.accentColor.opacity(0.16)))
            }
        case .note:
            Label(turn.text, systemImage: "info.circle").font(.lh(11.5)).foregroundStyle(.secondary)
        case .assistant:
            VStack(alignment: .leading, spacing: 8) {
                if !turn.text.isEmpty {
                    Text(markdown(turn.text)).font(.lh(12.5)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if !turn.streaming { ReadAloudButton(chat: chat, turn: turn) }
                }
                if let activity = turn.activity {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small).scaleEffect(0.5).frame(width: 12, height: 12)
                        Text(activity).font(.lh(11.5)).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                ForEach(turn.proposals) { proposal in ProposalCard(chat: chat, proposal: proposal) }
                if !turn.tasks.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(turn.tasks) { item in
                            Button { chat.showTask?(item.ref) } label: {
                                HStack(spacing: 6) {
                                    refTag(item.ref)
                                    Text(item.displayTitle).font(.lh(11.5)).lineLimit(1)
                                    Spacer(minLength: 0)
                                    Image(systemName: "arrow.right").font(.system(size: 9, weight: .bold)).foregroundStyle(.tertiary)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).help("Verla en la pestaña Runner")
                        }
                    }
                    .card()
                }
            }
        }
    }
}

/// Lo que propone el asistente: qué y por qué, y el botón que lo ejecuta (con confirmación y tu login).
struct ProposalCard: View {
    @ObservedObject var chat: AssistantModel
    let proposal: AssistantProposal

    var body: some View {
        let state = chat.proposalState[proposal.id]
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: proposal.symbol).font(.system(size: 10.5, weight: .bold))
                    .foregroundStyle(Color.accentColor)
                Text(proposal.isIssue ? (proposal.title ?? proposal.label) : proposal.label).font(.lh(12.5, .semibold)).lineLimit(2)
                Spacer(minLength: 4)
                if let ref = proposal.taskRef { refTag(ref) }
                else if let repo = proposal.repo { RepoTag(repo: repo.split(separator: "/").last.map(String.init) ?? repo) }
            }
            if let change = proposal.boardChange {
                Text(change).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary).lineLimit(2)
            }
            Text(proposal.reason).font(.lh(11.5)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if proposal.isBoardIssue {
                BoardIssueFields(chat: chat, runner: chat.runner, proposal: proposal, locked: state != nil && state?.hasPrefix("✗") != true)
            }
            HStack {
                if let result = chat.issueResults[proposal.id], result.ok, proposal.isBoardIssue {
                    BoardIssueOutcome(proposal: proposal, result: result)
                } else if let state, state != "…" {
                    Text(state).font(.lh(11.5, .semibold))
                        .foregroundStyle(state.hasPrefix("✓") ? Color.green : state.hasPrefix("⚠") ? Color.orange : Color.red)
                        .lineLimit(3)
                }
                Spacer(minLength: 0)
                if state == nil || state?.hasPrefix("✗") == true {
                    Button(proposal.isBoardIssue ? "Crear y agregar al board…" : proposal.isIssue ? "Abrir issue…" : "\(proposal.label)…") { chat.run(proposal) }
                        .buttonStyle(PillButtonStyle(prominent: true, compact: true)).fixedSize()
                } else if state == "…" {
                    ProgressView().controlSize(.small).scaleEffect(0.6)
                }
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.accentColor.opacity(0.07)))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Color.accentColor.opacity(0.2)))
    }
}

/// Un issue que va al board: la columna (las del proyecto, desde la bandeja) y el cuerpo plegado. Una vez abierto
/// la columna queda fija.
struct BoardIssueFields: View {
    @ObservedObject var chat: AssistantModel
    @ObservedObject var runner: RunnerModel
    let proposal: AssistantProposal
    let locked: Bool
    @State private var showBody = false

    var body: some View {
        let column = chat.column(for: proposal)
        let columns = chat.columns(for: proposal)
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "rectangle.stack.badge.plus").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
                Text("Columna").font(.lh(11.5)).foregroundStyle(.secondary)
                if columns.isEmpty || locked {
                    Text(column).font(.lh(11.5, .semibold))
                } else {
                    Menu {
                        ForEach(columns, id: \.self) { status in
                            Button { chat.boardColumn[proposal.id] = status } label: {
                                if status == column { Label(status, systemImage: "checkmark") } else { Text(status) }
                            }
                        }
                    } label: {
                        HStack(spacing: 3) {
                            Text(column).font(.lh(11.5, .semibold))
                            Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold))
                        }
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(Capsule().fill(Color.primary.opacity(0.07)))
                    }
                    .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
                    .help("En qué columna del board queda")
                }
                if let project = proposal.board?.project_id, runner.projects.count > 1 {
                    Text("· \(project)").font(.lh(11)).foregroundStyle(.tertiary).lineLimit(1)
                }
            }
            if let text = proposal.body, !text.isEmpty {
                Button { withAnimation(.easeOut(duration: 0.15)) { showBody.toggle() } } label: {
                    HStack(spacing: 4) {
                        Image(systemName: showBody ? "chevron.down" : "chevron.right").font(.system(size: 8.5, weight: .bold))
                        Text(showBody ? "Ocultar el cuerpo" : "Ver el cuerpo").font(.lh(11.5))
                    }
                    .foregroundStyle(.secondary).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if showBody {
                    Text(markdown(text)).font(.lh(11.5)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.primary.opacity(0.05)))
                }
            }
        }
    }
}

/// Cómo quedó un issue abierto para el board: en qué columna, o que se abrió pero no quedó (sin reintentar: el
/// issue ya existe). El issue, a un clic.
struct BoardIssueOutcome: View {
    let proposal: AssistantProposal
    let result: CreateIssueResult

    var body: some View {
        let repo = proposal.repo.flatMap { $0.split(separator: "/").last.map(String.init) } ?? proposal.repo ?? ""
        let number = result.number ?? result.url.flatMap { Int($0.split(separator: "/").last ?? "") }
        let ref = number.map { "\(repo)#\($0)" } ?? repo
        VStack(alignment: .leading, spacing: 2) {
            Button {
                if let url = result.url.flatMap(URL.init(string:)) { NSWorkspace.shared.open(url) }
            } label: {
                Text(result.board_error == nil
                     ? "✓ \(ref) abierto y en \(result.board_status ?? "el board")"
                     : "⚠ \(ref) abierto, pero no quedó en el board")
                    .font(.lh(11.5, .semibold)).lineLimit(2)
                    .foregroundStyle(result.board_error == nil ? Color.green : Color.orange)
            }
            .buttonStyle(.plain).disabled(result.url == nil).help("Abrir el issue en GitHub")
            if let error = result.board_error {
                Text(error).font(.lh(11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// El markdown de una respuesta como texto con formato: negritas, cursivas, código y links en línea; los títulos
/// van en negrita y las viñetas como «•» (SwiftUI no dibuja bloques).
func markdown(_ text: String) -> AttributedString {
    let lines = text.components(separatedBy: "\n").map { line -> String in
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if let heading = trimmed.firstMatch(#"^#{1,6}\s+(.*)$"#) { return "**\(heading[0])**" }
        if let bullet = line.firstMatch(#"^(\s*)[-*+]\s+(.*)$"#) { return "\(bullet[0])•  \(bullet[1])" }
        return line
    }
    let source = lines.joined(separator: "\n")
    return (try? AttributedString(markdown: source, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
        ?? AttributedString(text)
}

/// El 🔊 de una respuesta: la lee de nuevo (el resumen hablado si vino); mientras la lee, ■ la calla.
struct ReadAloudButton: View {
    @ObservedObject var chat: AssistantModel
    let turn: ChatTurn
    @ObservedObject private var voice = ReadAloud.shared

    var body: some View {
        let reading = voice.speaking == turn.id
        IconButton(symbol: reading ? "stop.circle" : "speaker.wave.2", help: reading ? "Dejar de leer" : "Leer en voz alta",
                   tint: reading ? .accentColor : .secondary) { chat.readAloud(turn) }
            .padding(.top, -4)
    }
}
