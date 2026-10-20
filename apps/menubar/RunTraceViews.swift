import SwiftUI

// La pantalla «En vivo» de la pestaña Runner: qué está haciendo el agente de una tarea, paso a paso (cada tool con su
// comando y su resultado, los avisos del workspace, el prompt), y las ejecuciones anteriores. Sólo dibuja RunWatch.

struct RunTraceScreen: View {
    @ObservedObject var runner: RunnerModel
    @ObservedObject var watch: RunWatch

    var body: some View {
        VStack(spacing: 0) {
            header.padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 8)
            status.padding(.horizontal, 14).padding(.bottom, 8)
            if let error = watch.error {
                Banner(text: error, tone: .bad, icon: "xmark.octagon.fill").padding(.horizontal, 14).padding(.bottom, 8)
            }
            if let failure = watch.execution?.failure {
                Banner(text: failure.message, tone: .bad, icon: "xmark.octagon.fill").padding(.horizontal, 14).padding(.bottom, 8)
            } else if let summary = watch.execution?.summary, !watch.running {
                Banner(text: summary, tone: .ok, icon: "checkmark.circle.fill").padding(.horizontal, 14).padding(.bottom, 8)
            }
            steps
            Divider().opacity(0.5)
            footer.padding(.horizontal, 14).padding(.vertical, 10)
        }
    }

    // MARK: encabezado: la tarea y qué ejecución

    private var header: some View {
        HStack(alignment: .top, spacing: 8) {
            IconButton(symbol: "chevron.left", help: "Volver") { runner.closeRun() }
            // El título solo en su línea (con los chips al lado se partía en dos); la ref y el PR, debajo del nombre.
            VStack(alignment: .leading, spacing: 4) {
                Text(watch.running ? "En vivo" : "Ejecución").font(.lh(17, .bold)).lineLimit(1).fixedSize()
                Text(watch.item.displayTitle).font(.lh(12)).foregroundStyle(.secondary).lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    Button { runner.open(watch.item) } label: { refTag(watch.ref) }.buttonStyle(.plain).fixedSize()
                        .help("Abrir \(watch.ref) en GitHub")
                    if let pr = watch.item.pr {
                        Button { runner.openPR(watch.item) } label: { Chip(text: "PR #\(pr.number)", tone: .info, icon: "arrow.up.right") }
                            .buttonStyle(.plain).fixedSize().help("Abrir el PR #\(pr.number) en GitHub")
                    }
                }
                BlockersLine(runner: runner, item: watch.item)
            }
            Spacer(minLength: 4)
            if watch.executions.count > 1 { executionMenu }
        }
    }

    private var executionMenu: some View {
        Menu {
            ForEach(watch.executions, id: \.id) { execution in
                Button { watch.select(execution.id) } label: {
                    let text = "\(execution.pipeline_id) · \(statusLabel(execution.status)) · \(ago(execution.started_at) ?? "")"
                    if execution.id == watch.execution?.id { Label(text, systemImage: "checkmark") } else { Text(text) }
                }
            }
        } label: {
            HStack(spacing: 3) {
                Image(systemName: "clock.arrow.circlepath").font(.system(size: 10.5, weight: .semibold))
                Text("\(watch.executions.count)").font(.lh(11, .semibold))
            }
            .padding(.horizontal, 7).padding(.vertical, 3)
            .foregroundStyle(.secondary)
            .background(Capsule().fill(Color.primary.opacity(0.07)))
        }
        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
        .help("Otras ejecuciones de esta tarea")
    }

    // MARK: estado: corriendo hace cuánto, qué hace ahora, tokens

    private var status: some View {
        let execution = watch.execution
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                if let execution {
                    Chip(text: statusLabel(execution.status), tone: tone(execution.status), icon: watch.running ? "dot.radiowaves.left.and.right" : nil)
                    // con varios agentes, el pipeline: cada agente va en su línea (y filtra la traza)
                    Text([watch.agents.isEmpty ? execution.agentLabel ?? execution.pipeline_id : execution.pipeline_id, elapsed(execution)]
                        .compactMap { $0 }.joined(separator: " · "))
                        .font(.lh(11.5)).foregroundStyle(.secondary).lineLimit(1)
                } else if !watch.loaded {
                    ProgressView().controlSize(.small).scaleEffect(0.6)
                    Text("Cargando la traza…").font(.lh(11.5)).foregroundStyle(.secondary)
                } else {
                    Text("Esta tarea no tiene ejecuciones.").font(.lh(11.5)).foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                if let usage = execution?.usage {
                    Text("\(tokens(usage.output_tokens)) tokens").font(.lh(11)).foregroundStyle(.tertiary)
                        .help("Salida: \(usage.output_tokens) · entrada: \(usage.input_tokens) · caché: \(usage.cache_read_tokens)")
                }
            }
            if !watch.agents.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    AgentsLine(entries: watch.agents, selected: watch.agentFilter) { watch.agentFilter = $0 }
                }
            }
            if watch.running, let current = watch.current {
                // con varios agentes y sin filtro, de quién es lo de ahora
                let who = watch.agents.isEmpty || watch.agentFilter != nil ? "" : current.agent.map { " (\(agentName($0)))" } ?? ""
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small).scaleEffect(0.5).frame(width: 12, height: 12)
                    Text("Ahora\(who): " + (current.tool.flatMap { RunTrace.summary(tool: $0, input: current.input) }.map { "\(current.title) · \($0)" } ?? current.title))
                        .font(.lh(11.5, .medium)).lineLimit(1)
                }
            }
        }
    }

    // MARK: los pasos

    private var steps: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if watch.loaded, watch.visibleSteps.isEmpty {
                        Text("Todavía no hay pasos.").font(.lh(12)).foregroundStyle(.tertiary).padding(6)
                    }
                    ForEach(watch.visibleSteps) { step in
                        StepRow(step: step, expanded: watch.expanded.contains(step.id)) { watch.toggle(step.id) }.id(step.id)
                    }
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollHeight(popoverMaxScroll - 60)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.primary.opacity(0.045)))
            .padding(.horizontal, 14).padding(.bottom, 10)
            .onChange(of: watch.visibleSteps.count) { _, _ in
                if watch.follow, let last = watch.visibleSteps.last { proxy.scrollTo(last.id, anchor: .bottom) }
            }
            .onAppear { if let last = watch.visibleSteps.last { proxy.scrollTo(last.id, anchor: .bottom) } }
        }
    }

    // MARK: pie: la acción de la tarea, «Más», preguntar, opciones

    /// Una sola fila, como la barra del detalle de la web: la acción del caso a la vista y el resto en «Más».
    private var footer: some View {
        let actions = actionsOf(watch.item)
        let main = mainAction(actions)
        let rest = actions.filter { $0.id != main?.id }
        let busy = runner.busy.contains(watch.item.ref)
        return HStack(spacing: 8) {
            if let main {
                Button(main.confirms ? "\(main.label)…" : main.label) { runner.trigger(main, on: watch.item) }
                    .buttonStyle(PillButtonStyle(prominent: main.id != "stop", tint: main.id == "stop" ? .red : .accentColor, compact: true))
                    .fixedSize().disabled(busy)
            }
            if !rest.isEmpty {
                Menu {
                    ForEach(rest) { action in
                        Button(action.confirms ? "\(action.label)…" : action.label, role: action.id == "stop" ? .destructive : nil) {
                            runner.trigger(action, on: watch.item)
                        }
                    }
                } label: { Text("Más · \(rest.count)").font(.lh(11.5, .semibold)) }
                    .menuStyle(.button).buttonStyle(PillButtonStyle(compact: true)).menuIndicator(.hidden).fixedSize()
                    .disabled(busy)
            }
            IconButton(symbol: "bubble.left.and.text.bubble.right", help: "Preguntarle al asistente sobre esta tarea") { runner.onAsk?(watch.item) }
            Spacer(minLength: 4)
            Text(watch.running ? "cada 3 s" : "terminó").font(.lh(11)).foregroundStyle(.tertiary)
            Toggle(isOn: $watch.follow) { Image(systemName: "arrow.down.to.line") }
                .toggleStyle(.button).buttonStyle(.plain).foregroundStyle(watch.follow ? Color.accentColor : .secondary)
                .help("Seguir el final")
            Toggle(isOn: $watch.showModel) { Image(systemName: "cpu") }
                .toggleStyle(.button).buttonStyle(.plain).foregroundStyle(watch.showModel ? Color.accentColor : .secondary)
                .help("Mostrar las llamadas al modelo")
            IconButton(symbol: "doc.on.doc", help: "Copiar la traza") { watch.copy(); runner.toast?("Traza copiada") }
            IconButton(symbol: "arrow.clockwise", help: "Releer") { watch.reload() }
        }
    }

    private func statusLabel(_ status: String) -> String {
        switch status {
        case "running": return "corriendo"
        case "paused": return "en pausa"
        case "done": return "terminó"
        case "failed": return "falló"
        case "superseded": return "reemplazada"
        default: return status
        }
    }

    private func tone(_ status: String) -> Tone {
        switch status {
        case "running": return .ok
        case "failed": return .bad
        case "paused": return .warn
        default: return .neutral
        }
    }

    /// Hace cuánto corre, o cuánto duró.
    private func elapsed(_ execution: ExecutionSummary) -> String? {
        guard let start = RunTrace.date(execution.started_at) else { return nil }
        let end = execution.closed_at.flatMap(RunTrace.date) ?? Date()
        let seconds = end.timeIntervalSince(start)
        // pasado el minuto, sin segundos: el número no salta en cada relectura
        let text = RunTrace.duration(seconds < 60 ? seconds * 1000 : (seconds / 60).rounded(.down) * 60_000)
        return execution.status == "running" ? "hace \(text)" : "duró \(text)"
    }

    private func tokens(_ n: Int) -> String { n >= 1000 ? String(format: "%.1fk", Double(n) / 1000) : String(n) }
}

/// Un paso: ícono según qué es y cómo terminó, el título, lo que lo identifica, y al tocarlo el input y el resultado.
struct StepRow: View {
    let step: RunStep
    let expanded: Bool
    let toggle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button { if step.expandable { toggle() } } label: {
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    icon.frame(width: 14)
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 5) {
                            Text(step.title).font(.lh(12, step.kind == .stage ? .bold : .semibold))
                                .foregroundStyle(step.kind == .model ? Color.secondary : step.state == .failed ? Color.red : Color.primary)
                                .lineLimit(step.kind == .note ? 3 : 1)
                            if let summary { Text(summary).font(.lh(12)).foregroundStyle(.secondary).lineLimit(1) }
                        }
                        if let command, !expanded {
                            Text(command).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1)
                        } else if let subtitle = step.subtitle, summary == nil {
                            Text(subtitle).font(.lh(11)).foregroundStyle(step.state == .failed ? Color.red.opacity(0.85) : .secondary).lineLimit(2)
                        }
                    }
                    Spacer(minLength: 4)
                    Text(step.durationMs.map(RunTrace.duration) ?? step.time).font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.tertiary).fixedSize()
                    if step.expandable {
                        Image(systemName: "chevron.right").font(.system(size: 8, weight: .bold)).foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                    }
                }
                .padding(.horizontal, 6).padding(.vertical, 4)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded { detail.padding(.leading, 27).padding(.trailing, 6).padding(.bottom, 4) }
        }
        .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(expanded ? Color.primary.opacity(0.05) : .clear))
    }

    private var summary: String? { step.tool.flatMap { RunTrace.summary(tool: $0, input: step.input) } }

    /// El comando de un Bash cuando la descripción ya va como resumen.
    private var command: String? {
        guard step.tool == "Bash", let command = RunTrace.command(input: step.input), command != summary else { return nil }
        return command
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let input = step.input, !input.isEmpty {
                block(step.tool == "Bash" ? (RunTrace.command(input: input) ?? input) : RunTrace.readable(input), label: "input")
            }
            if let result = step.result, !result.isEmpty {
                block(RunTrace.readable(result), label: step.kind == .tool ? "resultado" : nil)
            }
        }
    }

    private func block(_ text: String, label: String?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            if let label { Text(label.uppercased()).font(.lh(9.5, .bold)).foregroundStyle(.tertiary).tracking(0.5) }
            Text(text.count > 4000 ? String(text.prefix(4000)) + "\n…" : text)
                .font(.system(size: 10.5, design: .monospaced))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(7)
                .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color.primary.opacity(0.06)))
        }
    }

    @ViewBuilder private var icon: some View {
        switch step.state {
        case .running:
            ProgressView().controlSize(.small).scaleEffect(0.45).frame(width: 12, height: 12)
        case .failed:
            Image(systemName: "xmark.circle.fill").font(.system(size: 11)).foregroundStyle(.red)
        case .warn:
            Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 10.5)).foregroundStyle(.orange)
        case .ok, .info:
            Image(systemName: symbol).font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(step.kind == .stage ? Color.green : Color.secondary)
        }
    }

    private var symbol: String {
        switch step.kind {
        case .stage: return "checkmark.circle.fill"
        case .model: return "cpu"
        case .prompt: return "text.bubble"
        case .note: return "info.circle"
        case .tool:
            switch step.tool ?? "" {
            case "Bash": return "terminal"
            case "Read": return "doc.text"
            case "Edit", "Write", "MultiEdit": return "pencil"
            case "Grep", "Glob": return "magnifyingglass"
            case "WebFetch", "WebSearch": return "globe"
            case "TodoWrite": return "checklist"
            default: return step.title.hasPrefix("Subagente") ? "person.2" : "wrench.and.screwdriver"
            }
        }
    }
}
