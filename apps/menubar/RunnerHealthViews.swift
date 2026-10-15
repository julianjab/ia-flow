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
            if let ingress = health.ingress { sources(ingress) }
            if let webhooks = health.webhooks { listening(webhooks) }
            if let info = health.info { assistant(info) }
            if !health.problems.isEmpty { problems(health.problems) }
        }
    }

    // MARK: resumen

    private func summary(_ health: RunnerHealth, issues: [RunnerHealth.Issue]) -> some View {
        let worst = issues.first?.tone
        let (title, tone, icon): (String, Tone, String) = !health.alive
            ? ("No responde", .bad, "xmark.octagon.fill")
            : worst == .bad ? ("Con problemas", .bad, "exclamationmark.octagon.fill")
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
