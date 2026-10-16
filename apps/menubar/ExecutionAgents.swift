import SwiftUI

// Los agentes de UNA ejecución: un pipeline que corre agentes en paralelo (review: reviewer + e2e-visual-qa) es una
// sola ejecución y su `agent_id` es sólo el del último que cerró. `agents` (del runner) dice cada uno con su estado;
// acá se cuentan en una línea («reviewer ✓ · e2e-visual-qa ● hace 2 min»), en la bandeja y en «En vivo».

/// Un agente de una ejecución (`execution.agents[]` de `/api/inbox` y del detalle de una tarea).
struct ExecutionAgent: Codable, Hashable {
    let agent_id: String
    /// `running` | `waiting` | `done` | `failed` | `interrupted` | `unfinished`
    let state: String
    var started_at: String? = nil
    var ended_at: String? = nil
    var last_step_at: String? = nil
    /// Hace cuánto no da un paso (sólo mientras corre).
    var idle_seconds: Double? = nil
    var exit: String? = nil
    var summary: String? = nil
    /// Por qué falló: texto (el `failure` de la ejecución, en cambio, es `{by, message}`).
    var failure: String? = nil
}

/// `aiflow-reviewer` → `reviewer`: como se nombra un agente en el menú.
func agentName(_ id: String) -> String { id.replacingOccurrences(of: "aiflow-", with: "") }

extension ExecutionSummary {
    /// Los agentes cuando corrió más de uno; nil con uno solo o con un runner que no los manda.
    var parallelAgents: [ExecutionAgent]? { (agents?.count ?? 0) > 1 ? agents : nil }

    /// El agente que se nombra con uno solo: el de `agents` (el que corre) o el `agent_id` de siempre.
    var agentLabel: String? { (agents?.first?.agent_id ?? agent_id).map(agentName) }
}

extension ExecutionAgent {
    var running: Bool { state == "running" }

    var symbol: String {
        switch state {
        case "running": return "circle.fill"
        case "waiting": return "pause.fill"
        case "done": return "checkmark"
        case "failed": return "xmark"
        case "interrupted": return "stop.fill"
        default: return "ellipsis"
        }
    }

    var tone: Tone {
        switch state {
        case "running": return .ok
        case "waiting": return .warn
        case "failed": return .bad
        default: return .neutral
        }
    }

    /// `hace 2 min` si lleva un minuto o más sin dar un paso.
    var idle: String? {
        guard running, let seconds = idle_seconds, seconds >= 60 else { return nil }
        return "hace \(RunTrace.duration((seconds / 60).rounded(.down) * 60_000))"
    }

    var help: String {
        let states = ["running": "corriendo", "waiting": "esperando un evento", "done": "terminó", "failed": "falló",
                      "interrupted": "interrumpido", "unfinished": "sin terminar"]
        var lines = ["\(agentName(agent_id)): \(states[state] ?? state)"]
        if let idle { lines[0] += " · último paso \(idle)" }
        if let exit { lines.append("salida: \(exit)") }
        if let message = failure ?? summary { lines.append(message) }
        return lines.joined(separator: "\n")
    }
}

/// Una entrada de la línea: el agente con su estado, o sólo su id (cuando sale de la traza y no de `agents`).
struct AgentEntry: Hashable {
    let id: String
    var agent: ExecutionAgent? = nil
}

/// `reviewer ✓ · e2e-visual-qa ● hace 2 min`: el que corre, destacado. Con `onSelect`, cada uno filtra (otro clic
/// en el elegido vuelve a todos).
struct AgentsLine: View {
    let entries: [AgentEntry]
    var selected: String? = nil
    var onSelect: ((String?) -> Void)? = nil

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                if index > 0 { Text("·").font(.lh(11)).foregroundStyle(.tertiary) }
                if let onSelect {
                    Button { onSelect(selected == entry.id ? nil : entry.id) } label: { badge(entry) }
                        .buttonStyle(.plain)
                        .help([entry.agent?.help, selected == entry.id ? "Ver todos" : "Ver sólo su traza"]
                            .compactMap { $0 }.joined(separator: "\n"))
                } else {
                    badge(entry).help(entry.agent?.help ?? agentName(entry.id))
                }
            }
        }
        .lineLimit(1)
    }

    private func badge(_ entry: AgentEntry) -> some View {
        let agent = entry.agent
        let on = selected == entry.id
        let color: Color = agent.map { $0.tone == .neutral ? Color.secondary : $0.tone.color } ?? .secondary
        return HStack(spacing: 3) {
            Text(agentName(entry.id))
                .font(.lh(11, agent?.running == true || on ? .semibold : .regular))
                .foregroundStyle(agent?.running == true || on ? Color.primary : .secondary)
            if let agent {
                Image(systemName: agent.symbol)
                    .font(.system(size: agent.running ? 6 : 8, weight: .bold))
                    .foregroundStyle(color)
                if let idle = agent.idle { Text(idle).font(.lh(10.5)).foregroundStyle(.tertiary) }
            }
        }
        .padding(.horizontal, onSelect == nil ? 0 : 6).padding(.vertical, onSelect == nil ? 0 : 2)
        .background(Capsule().fill(on ? Color.accentColor.opacity(0.18) : onSelect == nil ? .clear : Color.primary.opacity(0.06)))
        .fixedSize()
    }
}
