import SwiftUI

// La pantalla «Estado del runner»: si responde y cuánto tarda, qué está mal, las ejecuciones y la capacidad, de dónde
// llegan los eventos, qué escucha y los últimos avisos del log. Sólo dibuja `RunnerModel.health`.

struct RunnerHealthScreen: View {
    @ObservedObject var runner: RunnerModel

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                IconButton(symbol: "chevron.left", help: "Volver") { runner.screen = .inbox }
                VStack(alignment: .leading, spacing: 1) {
                    Text("Estado del runner").font(.lh(17, .bold))
                    Text(runner.selected.name).font(.lh(12)).foregroundStyle(.secondary)
                }
                Spacer()
                if let health = runner.health {
                    let when = ago(isoString(health.checkedAt)) ?? "ahora"
                    Text(when == "ahora" ? "revisado ahora" : "revisado hace \(when)").font(.lh(11)).foregroundStyle(.tertiary)
                }
                IconButton(symbol: "arrow.clockwise", help: "Revisar de nuevo") { runner.checkHealth() }
            }
            .padding(.horizontal, 14).padding(.top, 14).padding(.bottom, 10)

            FittingScroll {
                VStack(alignment: .leading, spacing: 12) {
                    if let health = runner.health { content(health) }
                    else {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small).scaleEffect(0.6)
                            Text("Revisando \(runner.selected.name)…").font(.lh(12)).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading).card()
                    }
                }
                .padding(.horizontal, 14).padding(.bottom, 12)
            }
        }
    }

    @ViewBuilder private func content(_ health: RunnerHealth) -> some View {
        let issues = health.issues(pipeline: runner.inbox?.pipeline)
        summary(health, issues: issues)
        if health.alive {
            executions(health)
            if let resources = health.resources {
                machine("Runner", resources.runner, slots: nil)
                ForEach(resources.hosts) { host in
                    machine(host.name, host.resources, slots: (host.running, host.max_concurrent), lastSeen: host.last_seen)
                }
            }
            if let ingress = health.ingress { sources(ingress) }
            if let webhooks = health.webhooks { listening(webhooks) }
            if let info = health.info { assistant(info) }
            if !health.problems.isEmpty { problems(health.problems) }
        }
    }

    // MARK: resumen

    private func summary(_ health: RunnerHealth, issues: [RunnerHealth.Issue]) -> some View {
        let worst = issues.map(\.tone).contains(.bad) ? Tone.bad : issues.map(\.tone).contains(.warn) ? .warn : issues.first?.tone
        let (title, tone, icon): (String, Tone, String) = !health.alive
            ? ("No responde", .bad, "xmark.octagon.fill")
            : worst == .bad ? ("Con problemas", .bad, "exclamationmark.octagon.fill")
            : health.saturated(pipeline: runner.inbox?.pipeline) ? ("A tope", .warn, "gauge.with.dots.needle.100percent")
            : worst == .warn ? ("Responde, con avisos", .warn, "exclamationmark.triangle.fill")
            : ("Todo bien", .ok, "checkmark.seal.fill")
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: icon).font(.system(size: 18, weight: .semibold)).foregroundStyle(tone.color)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.lh(14, .bold))
                    Text([health.info.map { "v\($0.version)" }, health.latencyMs.map { "\($0) ms" }].compactMap { $0 }.joined(separator: " · "))
                        .font(.lh(11.5)).foregroundStyle(.secondary)
                }
                Spacer()
            }
            ForEach(issues) { issue in
                Label(issue.text, systemImage: issue.tone == .info ? "info.circle" : "exclamationmark.circle")
                    .font(.lh(12)).foregroundStyle(issue.tone == .info ? Color.secondary : issue.tone.color)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(tone.color.opacity(0.1)))
    }

    // MARK: ejecuciones y capacidad

    private func executions(_ health: RunnerHealth) -> some View {
        let pipeline = runner.inbox?.pipeline
        let counts = health.webhooks?.executions
        return VStack(alignment: .leading, spacing: 8) {
            SectionTitle(text: "Ejecuciones", trailing: pipeline?.capacity.map { "capacidad \($0)" })
            HStack(spacing: 8) {
                metric("\(counts?.running ?? pipeline?.running ?? 0)", "corriendo", .ok)
                metric("\(pipeline?.queued ?? counts?.waiting ?? 0)", "en cola", .info)
                metric("\(counts?.paused ?? pipeline?.paused ?? 0)", "en pausa", .warn)
                if let free = pipeline?.free { metric("\(free)", "libres", free == 0 ? .bad : .neutral) }
            }
        }
        .card()
    }

    private func metric(_ value: String, _ label: String, _ tone: Tone) -> some View {
        VStack(spacing: 1) {
            Text(value).font(.lh(18, .bold)).foregroundStyle(tone == .neutral ? Color.primary : tone.color)
            Text(label).font(.lh(10.5)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.primary.opacity(0.05)))
    }

    // MARK: recursos de cada máquina

    /// El runner o un host: sus lugares (si es host), memoria, disco, carga y worktrees.
    private func machine(_ name: String, _ resources: MachineResources?, slots: (Int, Int)?, lastSeen: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: slots == nil ? "server.rack" : "desktopcomputer").font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                Text(name).font(.lh(12.5, .bold)).lineLimit(1)
                if let slots {
                    Chip(text: "\(slots.0)/\(slots.1) corriendo", tone: slots.0 >= slots.1 ? .warn : .ok)
                }
                Spacer(minLength: 4)
                if let worktrees = resources?.worktrees {
                    Label("\(worktrees)", systemImage: "arrow.triangle.branch").font(.lh(11, .semibold)).foregroundStyle(.secondary)
                        .help("\(worktrees) worktrees de tareas en disco")
                }
            }
            if let resources {
                if let memory = resources.memory {
                    UsageBar(label: memory.source == "cgroup" ? "Memoria (contenedor)" : "Memoria", usage: memory,
                             detail: resources.process_rss_bytes.map { "proceso \(formatBytes($0))" })
                }
                if let disk = resources.disk { UsageBar(label: "Disco", usage: disk, detail: disk.path) }
                if let load = resources.load {
                    let ratio = load.cpus > 0 ? load.load1 / load.cpus : 0
                    HStack {
                        Text("Carga").font(.lh(11.5)).foregroundStyle(.secondary)
                        Spacer()
                        Text("\(String(format: "%.2f", load.load1)) · \(formatCpus(load.cpus)) CPU").font(.lh(11.5, .semibold))
                            .foregroundStyle(ratio >= 1.5 ? Color.orange : .primary)
                    }
                }
            } else if slots != nil {
                Text("Este host no manda sus recursos (es anterior).").font(.lh(11)).foregroundStyle(.tertiary)
            }
            if let lastSeen, let when = ago(lastSeen), when != "ahora" {
                Text("último contacto hace \(when)").font(.lh(10.5)).foregroundStyle(.tertiary)
            }
        }
        .card()
    }

    // MARK: entradas

    private func sources(_ ingress: IngressInfo) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(text: "Entradas", trailing: "se guardan \(ingress.retention_days) días")
            ForEach(ingress.sources) { source in
                HStack(spacing: 8) {
                    Circle().fill(source.configured ? Color.green : Color.secondary.opacity(0.5)).frame(width: 7, height: 7)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(source.name).font(.lh(12.5, .semibold))
                        Text(source.configured
                             ? (source.last_at.flatMap { ago($0) }.map { "último evento hace \($0)" } ?? "sin eventos todavía")
                             : "sin configurar" + (source.missing.map { " (falta \($0))" } ?? ""))
                            .font(.lh(11)).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if source.configured {
                        VStack(alignment: .trailing, spacing: 1) {
                            Text("\(source.count_24h)").font(.lh(12.5, .bold))
                            Text("en 24 h").font(.lh(10)).foregroundStyle(.tertiary)
                        }
                    }
                }
            }
        }
        .card()
    }

    private func listening(_ webhooks: WebhookStatus) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(text: "Webhooks", trailing: webhooks.secretConfigured == true ? "secreto configurado" : "sin secreto")
            if let projects = webhooks.projects, !projects.isEmpty {
                Text(projects.map { "\($0.id)" + ($0.board.map { " → \($0)" } ?? "") }.joined(separator: "\n"))
                    .font(.lh(12)).foregroundStyle(.secondary)
            }
            if let events = webhooks.listening, !events.isEmpty {
                FlowLayout(spacing: 4) {
                    ForEach(events, id: \.self) { event in
                        Text(event.replacingOccurrences(of: "github.", with: "")).font(.system(size: 10.5, design: .monospaced))
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Capsule().fill(Color.primary.opacity(0.07)))
                    }
                }
            }
        }
        .card()
    }

    private func assistant(_ info: RunnerInfo) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "bubble.left.and.text.bubble.right").foregroundStyle(info.assistant ? Color.green : Color.secondary)
            Text(info.assistant ? "Asistente disponible" : "Sin asistente").font(.lh(12.5, .semibold))
            Spacer()
            if let agents = info.assistant_agents, !agents.isEmpty {
                Text(agents.map(\.label).joined(separator: " · ")).font(.lh(11)).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .card()
    }

    // MARK: avisos del log

    private func problems(_ lines: [RunnerLogLine]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionTitle(text: "Últimos avisos del log")
            ForEach(lines.suffix(6)) { line in LogLineView(line: line).lineLimit(3) }
            Button("Ver logs del server") { runner.screen = .logs; runner.pollLogs() }
                .buttonStyle(PillButtonStyle(compact: true)).fixedSize()
        }
        .card()
    }

    private func isoString(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }
}

/// Una barra de uso (memoria, disco): verde, naranja desde el 80 %, rojo desde el 90 %.
struct UsageBar: View {
    let label: String
    let usage: ResourceUsage
    var detail: String? = nil

    var body: some View {
        let ratio = min(max(usage.ratio, 0), 1)
        let tone: Tone = ratio >= 0.9 ? .bad : ratio >= 0.8 ? .warn : .ok
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                Text(label).font(.lh(11.5)).foregroundStyle(.secondary)
                if let detail { Text("· \(detail)").font(.lh(10.5)).foregroundStyle(.tertiary).lineLimit(1) }
                Spacer(minLength: 4)
                Text("\(formatBytes(usage.used_bytes)) de \(formatBytes(usage.total_bytes))").font(.lh(11.5, .semibold))
                Text("\(Int(ratio * 100)) %").font(.lh(11.5, .bold)).foregroundStyle(tone.color).frame(width: 38, alignment: .trailing)
            }
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.08))
                    Capsule().fill(tone.color).frame(width: max(4, g.size.width * ratio))
                }
            }
            .frame(height: 5)
        }
    }
}
