import AppKit
import SwiftUI

// La pantalla «Mejoras propuestas» de la pestaña Runner (lo que dejó la retrospectiva al mergearse un PR) y su
// «¿Por qué?»: un chat con el asistente sobre la ejecución que la propuso. Sólo dibuja lo que publican RunnerModel y
// el AssistantModel de la mejora.

struct ImprovementsScreen: View {
    @ObservedObject var runner: RunnerModel

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                IconButton(symbol: "chevron.left", help: "Volver") { runner.goBack() }
                VStack(alignment: .leading, spacing: 1) {
                    Text("Mejoras propuestas").font(.lh(17, .bold))
                    Text("Las deja la retrospectiva al mergearse un PR").font(.lh(12)).foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                if runner.loading { ProgressView().controlSize(.small).scaleEffect(0.6) }
            }
            .padding(.horizontal, 14).padding(.top, 14).padding(.bottom, 10)

            FittingScroll {
                VStack(alignment: .leading, spacing: 0) {
                    if runner.improvements.isEmpty {
                        Text("Nada propuesto por decidir.").font(.lh(12)).foregroundStyle(.tertiary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    ForEach(Array(runner.improvements.enumerated()), id: \.element.id) { i, improvement in
                        if i > 0 { Divider().opacity(0.4).padding(.vertical, 10) }
                        ImprovementRow(runner: runner, improvement: improvement)
                    }
                }
                .card()
                .padding(.horizontal, 14)
                .padding(.bottom, 12)
            }
        }
    }
}

/// «¿Por qué?»: la mejora arriba (con su cuerpo a un clic) y el chat con el asistente sobre la tarea que la originó
/// (sin tarea, en el contexto general).
struct ImprovementChatScreen: View {
    @ObservedObject var runner: RunnerModel
    let improvement: Improvement
    @ObservedObject var chat: AssistantModel

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                IconButton(symbol: "chevron.left", help: "Volver a las mejoras") { runner.goBack() }
                Text("¿Por qué?").font(.lh(17, .bold))
                Spacer()
                IconButton(symbol: "square.and.pencil", help: "Conversación nueva") { chat.discuss(improvement) }
            }
            .padding(.horizontal, 14).padding(.top, 14).padding(.bottom, 10)

            ImprovementRow(runner: runner, improvement: improvement, detailed: true)
                .card().padding(.horizontal, 14).padding(.bottom, 8)

            if chat.available == false {
                Banner(text: "\(runner.selected.name) no tiene el asistente configurado.", tone: .neutral, icon: "bubble.left")
                    .padding(.horizontal, 14).padding(.bottom, 12)
            } else {
                if let login = runner.login {
                    DeviceLoginCard(runner: runner, login: login).padding(.horizontal, 14).padding(.bottom, 8)
                }
                thread
                Divider().opacity(0.5)
                ChatComposer(chat: chat, placeholder: "Pregunta por qué la propuso…")
                    .padding(.horizontal, 14).padding(.vertical, 10)
            }
        }
    }

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
            .scrollHeight(popoverMaxScroll - 180)
            .onChange(of: chat.turns.last?.text) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
            .onChange(of: chat.turns.count) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }

    private var suggestions: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(improvement.task_ref.map { "El asistente lee la ejecución de \(improvement.agent) sobre \($0) y te cuenta qué vio." }
                 ?? "No sale de una tarea: el asistente la mira en el contexto general y te cuenta por qué conviene.")
                .font(.lh(12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            FlowLayout {
                ForEach(["¿Por qué propusiste esto?", "¿Qué viste en la ejecución que lo justifica?", "¿Qué pasa si no se hace?"],
                        id: \.self) { q in
                    SelectChip(label: q, selected: false) { chat.input = q; chat.send() }
                }
            }
        }
        .padding(.top, 6)
    }
}

/// Una mejora propuesta por un agente: dónde se arregla, qué y por qué; abrirla como issue, descartarla o preguntar
/// por qué. `detailed` (en «¿Por qué?»): la razón entera y el cuerpo del issue a un clic, sin el botón de preguntar.
struct ImprovementRow: View {
    @ObservedObject var runner: RunnerModel
    let improvement: Improvement
    var detailed = false
    @State private var showBody = false

    var body: some View {
        let busy = runner.busy.contains(improvement.id)
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Chip(text: target, tone: .info).fixedSize()
                RepoTag(repo: improvement.repo.split(separator: "/").last.map(String.init) ?? improvement.repo)
                    .help("El issue se abre en \(improvement.repo)")
                Text([ago(improvement.created_at), improvement.taskLabel.map { "de \($0)" }]
                        .compactMap { $0 }.joined(separator: " · "))
                    .font(.lh(11)).foregroundStyle(.tertiary).lineLimit(1)
                Spacer(minLength: 0)
            }
            Text(improvement.title).font(.lh(13, .semibold)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
            Text(improvement.reason).font(.lh(11.5)).foregroundStyle(.secondary).lineLimit(detailed ? nil : 3)
                .fixedSize(horizontal: false, vertical: true)
            if detailed, showBody {
                ScrollView {
                    Text(markdown(improvement.body)).font(.lh(11.5)).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 140)
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.primary.opacity(0.05)))
            }
            HStack(spacing: 6) {
                Button { runner.decide(improvement, open: true) } label: {
                    if busy { ProgressView().controlSize(.small).scaleEffect(0.5).frame(width: 40, height: 14) } else { Text("Abrir issue…") }
                }
                .buttonStyle(PillButtonStyle(tint: Palette.blue, compact: true)).fixedSize().disabled(busy)
                Button("Descartar…") { runner.decide(improvement, open: false) }
                    .buttonStyle(PillButtonStyle(tint: .secondary, compact: true)).fixedSize().disabled(busy)
                if detailed {
                    Button(showBody ? "Ocultar el issue" : "Ver el issue") { withAnimation(.easeOut(duration: 0.15)) { showBody.toggle() } }
                        .buttonStyle(PillButtonStyle(tint: .secondary, compact: true)).fixedSize()
                } else {
                    Button { runner.discuss(improvement) } label: { Label("¿Por qué?", systemImage: "bubble.left.and.text.bubble.right") }
                        .buttonStyle(PillButtonStyle(tint: .orange, compact: true)).fixedSize()
                        .help("Preguntarle al asistente por qué el agente propuso esto")
                }
                Spacer(minLength: 0)
                Menu {
                    if let ref = improvement.task_ref { Button("Abrir la tarea \(ref)") { runner.openTask(ref) } }
                    if let pr = improvement.pr_url, let url = URL(string: pr) { Button("Abrir el PR") { NSWorkspace.shared.open(url) } }
                    Button("Copiar el cuerpo del issue") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(improvement.body, forType: .string)
                    }
                } label: {
                    Image(systemName: "ellipsis").font(.system(size: 12, weight: .semibold)).frame(width: 24, height: 20).contentShape(Rectangle())
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().foregroundStyle(.secondary)
            }
            .padding(.top, 2)
        }
        .help(detailed ? "" : improvement.body)
    }

    private var target: String {
        switch improvement.target {
        case "docs": return "docs"
        case "config": return "config del runner"
        case "engine": return "ia-flow"
        default: return improvement.target
        }
    }
}
