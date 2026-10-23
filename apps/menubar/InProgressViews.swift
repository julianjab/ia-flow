import SwiftUI

// «En curso»: los lugares del runner (ocupados y libres, y quién toma el libre), lo que corre ahora (con sus agentes en
// paralelo), lo que espera lugar y lo que terminó hace poco.

struct InProgressView: View {
    @ObservedObject var runner: RunnerModel

    var body: some View {
        let running = runner.running, queued = runner.queued, recent = runner.recentRuns
        VStack(alignment: .leading, spacing: 14) {
            if let pipeline = runner.inbox?.pipeline { RunnerSlots(runner: runner, pipeline: pipeline, running: running, queued: queued) }
            if running.isEmpty {
                let free = runner.inbox?.pipeline?.free
                Text(free.map { "Nada corre. \($0 == 1 ? "1 lugar libre" : "\($0) lugares libres")." } ?? "Nada corre.")
                    .font(.lh(12)).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).card()
            } else {
                InboxSection(title: "Corriendo ahora", plain: true) {
                    VStack(spacing: 8) { ForEach(running, id: \.ref) { RunningCard(runner: runner, item: $0) } }
                }
            }
            if !queued.isEmpty {
                InboxSection(title: "Esperando lugar", count: queued.count) {
                    ForEach(Array(queued.enumerated()), id: \.element.ref) { i, item in
                        if i > 0 { Divider().opacity(0.4).padding(.vertical, 6) }
                        QueueRow(runner: runner, item: item, position: i + 1)
                    }
                }
            }
            if !recent.isEmpty {
                InboxSection(title: "Terminó hace poco") {
                    ForEach(Array(recent.enumerated()), id: \.element.ref) { i, item in
                        if i > 0 { Divider().opacity(0.4).padding(.vertical, 2) }
                        RecentRow(runner: runner, item: item)
                    }
                }
            }
        }
    }
}

/// «Lugares del runner · 2 de 3 ocupados»: una celda por lugar (la etapa y la tarea, o «libre» punteada) y quién
/// toma el libre.
struct RunnerSlots: View {
    @ObservedObject var runner: RunnerModel
    let pipeline: InboxPipeline
    let running: [InboxItem]
    let queued: [InboxItem]

    var body: some View {
        let capacity = pipeline.capacity ?? max(running.count, 1)
        let cells = max(capacity, running.count)
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("Lugares del runner").font(.lh(12.5, .semibold)).foregroundStyle(.secondary)
                Spacer()
                Text(occupancy(capacity)).font(.lh(11.5)).foregroundStyle(.tertiary)
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 6)], spacing: 6) {
                ForEach(0..<cells, id: \.self) { i in
                    if i < running.count { busy(running[i]) } else { free }
                }
            }
            if let line = nextLine { Text(line).font(.lh(11.5)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
        }
        .card()
    }

    private func occupancy(_ capacity: Int) -> String {
        var parts = [pipeline.capacity == nil ? "\(running.count) corriendo, sin tope" : "\(pipeline.running) de \(capacity) ocupados"]
        if pipeline.paused > 0 { parts.append("\(pipeline.paused) esperando CI") }
        if runner.live { parts.append("en vivo") }
        return parts.joined(separator: " · ")
    }

    private func busy(_ item: InboxItem) -> some View {
        Button { runner.showTask(item) } label: {
            HStack(spacing: 5) {
                Circle().fill(Palette.live).frame(width: 6, height: 6)
                Text(stageName(item)).font(.lh(11.5, .semibold)).lineLimit(1)
                Text("· \(item.shortRef)").font(.mono(10.5)).foregroundStyle(.secondary).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 8).padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Palette.control))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("\(item.ref) · \(item.title)")
    }

    private var free: some View {
        Text("libre").font(.lh(11.5)).foregroundStyle(.tertiary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 8).padding(.vertical, 6)
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.2), style: StrokeStyle(lineWidth: 1, dash: [3, 3])))
    }

    /// Quién toma el lugar libre (el 1.º de la cola) y cuántas esperan en Próximo.
    private var nextLine: String? {
        let ready = runner.inbox?.feed?.ready.count ?? 0
        let behind = ready > 0 ? " Detrás hay \(ready == 1 ? "1 card lista" : "\(ready) cards listas") en Próximo." : ""
        if let first = queued.first {
            if (pipeline.free ?? 1) > 0 { return "El lugar libre lo toma \(refLabel(first.ref)) (1.º en la cola).\(behind)" }
            return "Sin lugar libre: \(queued.count == 1 ? "1 espera" : "\(queued.count) esperan") a que termine una.\(behind)"
        }
        if (pipeline.free ?? 0) > 0, ready > 0 { return "Nada en la cola.\(behind)" }
        return nil
    }
}

/// La etapa que corre una tarea («Build», «Review»): el pipeline de su ejecución, o su columna.
func stageName(_ item: InboxItem) -> String {
    let raw = item.execution?.pipeline_id ?? item.status ?? item.kind
    return raw.prefix(1).uppercased() + raw.dropFirst()
}

/// `3.0k`
func formatTokens(_ n: Int) -> String { n >= 1000 ? String(format: "%.1fk", Double(n) / 1000) : String(n) }

/// Una tarea que corre: la etapa y la ref, hace cuánto, el título, sus agentes (si son varios), «Ver en vivo» y
/// «Detener…». Clic: el detalle.
struct RunningCard: View {
    @ObservedObject var runner: RunnerModel
    let item: InboxItem

    var body: some View {
        let run = item.execution
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                Text(stageName(item)).font(.lh(11.5, .semibold)).foregroundStyle(Palette.green)
                Text("· \(refLabel(item.ref))").font(.mono(11)).foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 4)
                if let started = run?.started_at, let age = ago(started) { Text(age).font(.lh(11)).foregroundStyle(.tertiary) }
            }
            Text(item.displayTitle).font(.lh(13.5, .semibold)).lineLimit(2).multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let agents = run?.parallelAgents {
                AgentsLine(entries: agents.map { AgentEntry(id: $0.agent_id, agent: $0) })
            } else if let idle = run?.idle_seconds, idle >= 90 {
                Text("Sin pasos hace \(Int(idle / 60)) min").font(.lh(11.5)).foregroundStyle(Palette.amber)
            }
            HStack(spacing: 8) {
                Button("Ver en vivo") { runner.watch(item) }.buttonStyle(PillButtonStyle(compact: true)).fixedSize()
                Text(meta).font(.lh(11)).foregroundStyle(.tertiary).lineLimit(1)
                Spacer(minLength: 4)
                if let stop = actionsOf(item).first(where: { $0.id == "stop" }) {
                    Button("Detener…") { runner.trigger(stop, on: item) }
                        .buttonStyle(PillButtonStyle(tint: Palette.red, compact: true)).fixedSize()
                        .disabled(runner.busy.contains(item.ref))
                }
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.card))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.line))
        .contentShape(Rectangle())
        .onTapGesture { runner.showTask(item) }
        .contextMenu { TaskMenu(runner: runner, item: item) }
        .help("Clic: el detalle · clic derecho: todas las acciones")
    }

    private var meta: String {
        guard let run = item.execution else { return "" }
        let who = run.parallelAgents != nil ? "pipeline \(run.pipeline_id)" : (run.agentLabel ?? run.pipeline_id)
        return [who, run.usage.map { "\(formatTokens($0.output_tokens)) tokens" }].compactMap { $0 }.joined(separator: " · ")
    }
}

/// Una que espera lugar: la etapa, la ref y su puesto en la cola, y el título.
struct QueueRow: View {
    @ObservedObject var runner: RunnerModel
    let item: InboxItem
    let position: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Text(item.kind == "dep" ? "Bloqueada" : item.execution == nil && item.status == nil ? "En cola" : stageName(item))
                    .font(.lh(11, .semibold)).foregroundStyle(Palette.amber)
                Text("· \(refLabel(item.ref)) · \(position).º en la cola").font(.mono(10.5)).foregroundStyle(.secondary).lineLimit(1)
            }
            Text(item.displayTitle).font(.lh(12.5)).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .onTapGesture { runner.showTask(item) }
        // lo que espera también se puede preguntar o comentar: que esté en cola no la deja sin manos
        .contextMenu { TaskMenu(runner: runner, item: item) }
        .help(item.why)
    }
}
