import SwiftUI

// El detalle de una tarea: la ruta de vuelta («‹ Para mí / subscriptions #4281»), el título con su columna, PR y épica,
// «Por qué te necesita» en una frase, y tres pestañas: Resumen (la línea de tiempo de sus ejecuciones), Ejecuciones
// (la más nueva primero; abre sola la que corre o la última que falló) y Eventos (con «¿Por qué no corrió?»). Al pie,
// una barra con un primario, «✦ Preguntar» y «Más ▾». Si el agente te preguntó algo, en vez del porqué: qué pasó, lo
// que dijo el agente (el único bloque en violeta) y la respuesta.

struct TaskDetailScreen: View {
    @ObservedObject var runner: RunnerModel
    @ObservedObject var watch: RunWatch
    @State private var tab = "summary"
    @State private var answer = ""
    @State private var showTech = false
    @State private var opened = false

    private var item: InboxItem { watch.item }
    private var asked: Bool { ["doubt", "prerequisite"].contains(item.kind) && item.agent_said != nil }

    var body: some View {
        VStack(spacing: 0) {
            RouteHeader(back: runner.backLabel, title: refLabel(item.ref), mono: true, onBack: { runner.goBack() }) {
                IconButton(symbol: "arrow.up.right", help: "Abrir el issue en GitHub") { runner.open(item) }
            }
            .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 8)
            FittingScroll {
                VStack(alignment: .leading, spacing: 12) {
                    head
                    if asked { question } else if item.isDecision { why }
                    if let error = watch.error { Banner(text: error, tone: .bad, icon: "xmark.octagon.fill") }
                    if !asked || showTech { tabs }
                    if asked {
                        DisclosureGroup("Detalle técnico", isExpanded: $showTech) { EmptyView() }
                            .font(.lh(12)).foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 14).padding(.bottom, 12)
            }
            if runner.inlineConfirm?.ref == item.ref {
                InlineConfirmView(runner: runner, item: item).padding(.horizontal, 14).padding(.bottom, 8)
            }
            if let failure = runner.failures[item.ref] {
                ActionErrorView(runner: runner, failure: failure).padding(.horizontal, 14).padding(.bottom, 8)
            }
            Divider().opacity(0.5)
            footer.padding(.horizontal, 14).padding(.vertical, 10)
        }
        .onAppear(perform: openInteresting)
        .onChange(of: watch.executions.count) { _, _ in openInteresting() }
    }

    // MARK: arriba

    private var head: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(item.displayTitle).font(.lh(15, .semibold)).fixedSize(horizontal: false, vertical: true)
            FlowLayout {
                if let status = item.status { Chip(text: "En \(status)") }
                if let pr = item.pr {
                    Button { runner.openPR(item) } label: { Chip(text: "PR #\(pr.number)", tone: .info, icon: "arrow.up.right") }
                        .buttonStyle(.plain).help("Abrir el PR #\(pr.number) en GitHub")
                }
                if let epic = item.epic {
                    Button { runner.showEpic(epic.ref) } label: {
                        Chip(text: "Épica · \(epic.done) de \(epic.total)", tone: .info, icon: "square.stack.3d.up")
                    }
                    .buttonStyle(.plain).help("Épica \(epic.ref): \(epic.title)")
                }
            }
            BlockersLine(runner: runner, item: item)
        }
    }

    /// «Por qué te necesita»: una o dos frases, en azul.
    private var why: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Por qué te necesita").font(.lh(11.5, .semibold)).foregroundStyle(Palette.link)
            Text(reason(item) + (item.agent_said.map { " «\($0)»" } ?? "")).font(.lh(12.5)).fixedSize(horizontal: false, vertical: true)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Palette.blue.opacity(0.12)))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.blue.opacity(0.3)))
    }

    /// El agente te preguntó: qué pasó, lo que dijo (violeta), qué hacer y tu respuesta.
    private var question: some View {
        let run = watch.executions.first ?? item.execution
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Chip(text: "Te preguntó", tone: .warn)
                if let run { Text("\(run.pipeline_id.prefix(1).uppercased() + run.pipeline_id.dropFirst()) · \(run.agentLabel ?? run.pipeline_id)").font(.lh(11.5)).foregroundStyle(.secondary) }
                Spacer()
                if let age = item.age { Text(age == "ahora" ? age : "hace \(age)").font(.lh(11.5)).foregroundStyle(.tertiary) }
            }
            VStack(alignment: .leading, spacing: 3) {
                Text("Qué pasó").font(.lh(11.5, .semibold)).foregroundStyle(.secondary)
                Text("El \(run?.agentLabel ?? "agente") frenó a mitad de la tarea: necesita que decidas algo antes de seguir.")
                    .font(.lh(12.5)).fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("✦ Lo que dijo el agente").font(.lh(11.5, .semibold)).foregroundStyle(Palette.ai)
                Text(item.agent_said ?? "").font(.lh(12.5)).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Palette.ai.opacity(0.1)))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.ai.opacity(0.35)))
            Text("→ Contestá en una línea. El agente retoma con tu respuesta.").font(.lh(12)).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 4) {
                Text("Tu respuesta").font(.lh(11.5, .semibold)).foregroundStyle(.secondary)
                TextEditor(text: $answer)
                    .font(.lh(13)).frame(height: 64).scrollContentBackground(.hidden)
                    .padding(6).background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Palette.control))
                Text("Se publica como comentario en el issue, con tu usuario de GitHub.").font(.lh(11)).foregroundStyle(.tertiary)
            }
        }
    }

    // MARK: pestañas

    private var tabs: some View {
        VStack(alignment: .leading, spacing: 10) {
            Segmented(options: [
                SegmentOption(id: "summary", title: "Resumen"),
                SegmentOption(id: "runs", title: "Ejecuciones · \(watch.executions.count)"),
                SegmentOption(id: "events", title: "Eventos"),
            ], selected: tab, compact: true) { tab = $0 }
            switch tab {
            case "runs": executions
            case "events": events
            default: summary
            }
        }
    }

    /// La línea de tiempo: cada ejecución, de la más vieja a la más nueva, y al final lo que te toca.
    private var summary: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !watch.loaded { ProgressView().controlSize(.small) }
            else if watch.executions.isEmpty { Text("Todavía no corrió ningún agente.").font(.lh(12)).foregroundStyle(.secondary) }
            ForEach(watch.executions.reversed(), id: \.id) { run in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(Self.glyph(run)).font(.lh(12, .bold)).foregroundStyle(Self.color(run)).frame(width: 14)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("\(run.pipeline_id.prefix(1).uppercased() + run.pipeline_id.dropFirst()) · \(Self.outcome(run))")
                            .font(.lh(12.5, .semibold)).lineLimit(1)
                        Text(Self.meta(run)).font(.lh(11)).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
            if item.isDecision, let main = mainAction(actionsOf(item)) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("●").font(.lh(11)).foregroundStyle(Palette.amber).frame(width: 14)
                    Text("Te toca: \(main.label.lowercased())").font(.lh(12.5, .semibold))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    /// Las ejecuciones, la más nueva primero; la elegida, abierta con sus pasos y «Ver la traza completa».
    private var executions: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(watch.executions, id: \.id) { run in
                let open = watch.execution?.id == run.id && opened
                VStack(alignment: .leading, spacing: 6) {
                    Button {
                        if watch.execution?.id == run.id { opened.toggle() } else { opened = true; watch.select(run.id) }
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(Self.glyph(run)).font(.lh(12, .bold)).foregroundStyle(Self.color(run)).frame(width: 14)
                            VStack(alignment: .leading, spacing: 1) {
                                Text("\(run.pipeline_id) · \(run.agentLabel ?? "")").font(.lh(12.5, .semibold)).lineLimit(1)
                                Text("\(Self.outcome(run)) · \(Self.meta(run))").font(.lh(11)).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer()
                            Image(systemName: "chevron.right").font(.system(size: 8.5, weight: .bold)).foregroundStyle(.tertiary)
                                .rotationEffect(.degrees(open ? 90 : 0))
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if open {
                        let steps = watch.visibleSteps
                        if !watch.loaded { ProgressView().controlSize(.small) }
                        ForEach(steps.suffix(8)) { step in
                            StepRow(step: step, expanded: watch.expanded.contains(step.id)) { watch.toggle(step.id) }
                        }
                        Button("Ver la traza completa") { runner.watch(item) }.buttonStyle(PillButtonStyle(compact: true)).fixedSize()
                    }
                }
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Palette.card))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.line))
            }
            if watch.loaded, watch.executions.isEmpty { Text("Sin ejecuciones.").font(.lh(12)).foregroundStyle(.secondary) }
        }
    }

    /// Cada evento con lo que decidió cada pipeline, más «¿Por qué no corrió?».
    private var events: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Eventos recientes").font(.lh(12, .semibold)).foregroundStyle(.secondary)
                Spacer()
                Button(watch.explaining ? "evaluando…" : "¿Por qué no corrió?") { watch.askWhy() }
                    .buttonStyle(PillButtonStyle(compact: true)).fixedSize().disabled(watch.explaining)
            }
            if let explain = watch.explain {
                VStack(alignment: .leading, spacing: 3) {
                    Text("¿Por qué no corrió?").font(.lh(12, .semibold))
                    Text("\(explain.event.type) · \(explain.source == "last_event" ? "el último que recibió la tarea" : "armado para la pregunta")")
                        .font(.mono(10.5)).foregroundStyle(.secondary)
                    ForEach(explain.decisions, id: \.self) { Text($0.line).font(.lh(12)) }
                    if explain.decisions.isEmpty { Text("Ninguna pipeline escucha este evento.").font(.lh(12)).foregroundStyle(.secondary) }
                }
                .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Palette.control))
            }
            if let error = watch.explainError { Text(error).font(.lh(12)).foregroundStyle(Palette.red) }
            ForEach(watch.events) { event in
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(Self.clock(event.occurred_at)).font(.mono(10.5)).foregroundStyle(.tertiary)
                        Text(event.type).font(.mono(11, .medium)).lineLimit(1)
                    }
                    if !event.detail.isEmpty { Text(event.detail).font(.lh(11.5)).foregroundStyle(.secondary).lineLimit(2) }
                    ForEach(event.decisions ?? [], id: \.self) { decision in
                        Text(decision.line).font(.lh(11.5)).foregroundStyle(decision.verdict == "ran" ? Palette.green : .secondary)
                    }
                }
                .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Palette.card))
            }
            if watch.loaded, watch.events.isEmpty { Text("Sin eventos registrados.").font(.lh(12)).foregroundStyle(.secondary) }
        }
    }

    // MARK: pie

    private var footer: some View {
        let actions = actionsOf(item)
        let main = asked ? actions.first { $0.id == "answer_and_unblock" } ?? mainAction(actions) : mainAction(actions)
        let busy = runner.busy.contains(item.ref)
        return HStack(spacing: 6) {
            if let main {
                Button {
                    if asked, main.comment != nil {
                        let text = answer.trimmingCharacters(in: .whitespacesAndNewlines)
                        if text.isEmpty { runner.trigger(main, on: item) } else { runner.send(main, on: item, comment: text); answer = "" }
                    } else {
                        runner.triggerInline(main, on: item)
                    }
                } label: { Text(main.confirms && !asked ? "\(main.label)…" : main.label) }
                    .buttonStyle(PillButtonStyle(prominent: true, tint: main.id == "stop" ? Palette.red : Palette.blue))
                    .fixedSize().disabled(busy)
            }
            Button { runner.onAsk?(item) } label: { Text("✦ Preguntar").foregroundStyle(Palette.ai) }
                .buttonStyle(PillButtonStyle()).fixedSize()
            Menu { TaskMenu(runner: runner, item: item, skip: main?.id) } label: { Text("Más ▾").font(.lh(12.5, .semibold)) }
                .menuStyle(.button).buttonStyle(PillButtonStyle()).menuIndicator(.hidden).fixedSize()
            Spacer(minLength: 0)
            if busy { ProgressView().controlSize(.small).scaleEffect(0.6) }
        }
    }

    /// Abre sola la que corre o la última que falló.
    private func openInteresting() {
        guard !opened, let run = watch.executions.first(where: { $0.status == "running" })
                ?? watch.executions.first.flatMap({ $0.status == "failed" ? $0 : nil }) else { return }
        opened = true
        if tab == "summary", run.status == "running" { tab = "runs" }
        if watch.execution?.id != run.id { watch.select(run.id) }
    }

    // MARK: formato

    static func glyph(_ run: ExecutionSummary) -> String {
        switch run.status {
        case "running": return "●"
        case "failed": return "✕"
        case "superseded": return "↷"
        default: return run.exit == "changes_requested" ? "↻" : "✓"
        }
    }

    static func color(_ run: ExecutionSummary) -> Color {
        switch run.status {
        case "running": return Palette.live
        case "failed": return Palette.red
        default: return run.exit == "changes_requested" ? Palette.amber : Palette.green
        }
    }

    static func outcome(_ run: ExecutionSummary) -> String {
        if run.status == "running" { return "corriendo" }
        if run.status == "failed" { return run.failure?.message ?? "falló" }
        if run.exit == "changes_requested" { return "pidió cambios" }
        return run.summary.map { $0.count > 48 ? String($0.prefix(47)) + "…" : $0 } ?? (run.exit ?? "terminó")
    }

    static func meta(_ run: ExecutionSummary) -> String {
        var parts = [run.agentLabel ?? run.pipeline_id]
        if let start = RunTrace.date(run.started_at) {
            let end = run.closed_at.flatMap(RunTrace.date) ?? Date()
            parts.append(RunTrace.duration(max(0, (end.timeIntervalSince(start) / 60).rounded(.down) * 60_000)))
        }
        if let age = (run.closed_at ?? Optional(run.started_at)).flatMap({ ago($0) }) { parts.append(age == "ahora" ? age : "hace \(age)") }
        return parts.joined(separator: " · ")
    }

    static func clock(_ iso: String) -> String {
        guard let date = RunTrace.date(iso) else { return "" }
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f.string(from: date)
    }
}
