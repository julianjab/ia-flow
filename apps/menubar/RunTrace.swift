import Foundation

// La traza de una ejecución como la cuenta la pantalla «En vivo»: lo que guarda el runner en `execution_trace`
// (spans al empezar y al terminar, y logs, escritos en el momento) llega en `GET /api/tasks/:owner/:repo/:n`
// (`?execution=`) y acá se pliega en pasos legibles: cada tool una vez, con su input, su resultado y cuánto tardó.
// Puro: sin red ni estado.

/// Un atributo de la traza como texto (el runner manda strings, números, booleanos o JSON).
struct LooseText: Decodable {
    let text: String

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { text = s }
        else if let b = try? c.decode(Bool.self) { text = String(b) }
        else if let d = try? c.decode(Double.self) { text = d.rounded() == d && abs(d) < 1e15 ? String(Int(d)) : String(d) }
        else if let a = try? c.decode([LooseText].self) { text = "[" + a.map(\.text).joined(separator: ", ") + "]" }
        else if let o = try? c.decode([String: LooseText].self) {
            text = "{" + o.map { "\($0.key): \($0.value.text)" }.sorted().joined(separator: ", ") + "}"
        } else { text = "" }
    }
}

/// Una fila de `execution_trace` (`TraceEntrySchema` de `packages/shared`).
struct TraceEntry: Decodable {
    let kind: String
    let phase: String?
    let name: String
    let scope: String?
    let level: String?
    let status: String?
    let status_message: String?
    let start_time: String
    let duration_ms: Double?
    let span_id: String
    let origin: String
    let attributes: [String: LooseText]

    func attr(_ key: String) -> String? { attributes[key]?.text }
}

/// El detalle de una tarea con la traza de una de sus ejecuciones (la última, o la de `?execution=`).
struct RunDetail: Decodable {
    let item: InboxItem
    /// De la más nueva a la más vieja.
    let executions: [ExecutionSummary]
    let trace: [TraceEntry]
}

struct ExecutionUsage: Codable, Hashable {
    let input_tokens: Int
    let output_tokens: Int
    let cache_read_tokens: Int
}

struct ExecutionFailure: Codable, Hashable {
    let by: String
    let message: String
}

extension RunnerClient {
    func run(ref: String, execution: String?) async throws -> RunDetail {
        guard let parts = RunnerSearch.split(ref) else { throw RunnerError(status: 0, message: "ref inválida: \(ref)") }
        let query = execution.map { "?execution=\($0)" } ?? ""
        return try await get("/api/tasks/\(parts.owner)/\(parts.repo)/\(parts.number)\(query)")
    }
}

// MARK: pasos

struct RunStep: Identifiable, Equatable {
    enum Kind { case stage, tool, model, prompt, note }
    enum State { case running, ok, failed, info, warn }

    let id: String
    let kind: Kind
    var state: State
    var title: String
    /// La línea de abajo: el comando de un Bash, el archivo de un Read, el motivo de un fallo.
    var subtitle: String?
    var input: String?
    var result: String?
    var time: String
    var durationMs: Double?
    var origin: String?
    /// El nombre crudo de la tool (`Bash`, `mcp__github__get_issue`).
    var tool: String?
    /// Cuándo empezó (ISO), para ordenar.
    var at = ""
    /// El agente que lo dio (`ia.agent.id`); nil en lo que es de la ejecución (el pipeline, el workspace).
    var agent: String? = nil

    var expandable: Bool { (input?.isEmpty == false) || (result?.isEmpty == false) }
}

enum RunTrace {
    /// Los spans que no son pasos propios: la llamada al modelo y la tool (se arman aparte).
    private static let tools: Set<String> = ["tool.pre", "tool.call", "tool.result"]

    /// Pliega la traza en pasos, en el orden en que aparecieron. `running`: si la ejecución sigue; si no, una
    /// tool sin final ya no corre.
    static func steps(_ trace: [TraceEntry], running: Bool) -> [RunStep] {
        var steps: [RunStep] = []
        var index: [String: Int] = [:]
        // Una tool de un MCP del runner deja hasta tres registros: el span del runner y el del host, sin id de llamada,
        // y los logs del hook, con id. Sin id se juntan por nombre con la última de ese nombre que todavía no lo tiene.
        var anonymous: [String: Int] = [:]
        var current = ""
        var agent: String?

        func upsert(_ key: String, _ make: () -> RunStep, _ update: (inout RunStep) -> Void) {
            if let i = index[key] {
                update(&steps[i])
                if steps[i].agent == nil { steps[i].agent = agent }
                return
            }
            var step = make()
            update(&step)
            step.at = current
            step.agent = agent
            index[key] = steps.count
            steps.append(step)
        }

        func append(_ step: RunStep) {
            var step = step
            step.at = current
            step.agent = step.agent ?? agent
            steps.append(step)
        }

        for e in trace {
            current = e.start_time
            agent = e.attr("ia.agent.id")
            let time = clock(e.start_time)
            let failed = e.status == "error"
            switch (e.kind, e.name) {
            case ("span", _) where e.attr("gen_ai.operation.name") == "execute_tool" || e.name == "execute_tool":
                let name = e.attr("gen_ai.tool.name") ?? "tool"
                let key = e.attr("gen_ai.tool.call.id") ?? anonymous[bareTool(name)].map { steps[$0].id } ?? e.span_id
                if e.attr("gen_ai.tool.call.id") == nil, index[key] == nil { anonymous[bareTool(name)] = steps.count }
                upsert(key, { tool(key, name, time) }) { step in
                    step.input = step.input ?? e.attr("ia.tool.input")
                    step.result = e.attr("ia.tool.result") ?? step.result
                    if e.phase == "end" {
                        step.durationMs = e.duration_ms
                        step.state = failed ? .failed : (step.state == .failed ? .failed : .ok)
                        if failed, let message = e.status_message { step.subtitle = message }
                    }
                }
            case ("span", "chat"), ("span", _) where e.attr("gen_ai.operation.name") == "chat":
                guard e.phase == "end" else { continue }
                let out = e.attr("gen_ai.usage.output_tokens").flatMap(Int.init)
                append(RunStep(id: e.span_id + "-chat", kind: .model, state: failed ? .failed : .info,
                                     title: "Modelo" + (out.map { " · \($0) tokens" } ?? ""),
                                     subtitle: failed ? e.status_message : e.attr("gen_ai.response.model"),
                                     time: time, durationMs: e.duration_ms))
            case ("span", _):
                upsert(e.span_id, { stage(e, time) }) { step in
                    guard e.phase == "end" else { return }
                    step.state = failed ? .failed : .ok
                    step.durationMs = e.duration_ms
                    if failed, let message = e.status_message { step.subtitle = message }
                    if let output = e.attr("ia.step.output") { step.result = output }
                }
            case ("log", let name) where tools.contains(name):
                let tool = e.attr("gen_ai.tool.name") ?? "tool"
                let key = e.attr("ia.tool.use_id") ?? e.span_id + name
                if index[key] == nil, let i = anonymous.removeValue(forKey: bareTool(tool)) { index[key] = i }
                upsert(key, { self.tool(key, tool, time) }) { step in
                    if let input = e.attr("ia.tool.input") { step.input = input }
                    if let result = e.attr("ia.tool.result") { step.result = result }
                    if e.attr("ia.tool.is_error") == "true" { step.state = .failed }
                    else if name == "tool.result", step.state == .running { step.state = .ok }
                }
            case ("log", "subagent.start"):
                append(RunStep(id: e.span_id + "-sub-\(steps.count)", kind: .tool, state: .info,
                                     title: "Subagente" + (e.attr("ia.subagent.type").map { " · \($0)" } ?? ""),
                                     subtitle: e.attr("ia.subagent.description"), result: e.attr("ia.subagent.prompt"),
                                     time: time, origin: e.origin))
            case ("log", "agent.prompt"):
                append(RunStep(id: e.span_id + "-prompt-\(steps.count)", kind: .prompt, state: .info, title: "Prompt del agente",
                                     subtitle: firstLine(e.attr("ia.prompt")), result: e.attr("ia.prompt"), time: time, origin: e.origin))
            case ("log", "agent.session_start"):
                append(note(e, "Sesión del agente iniciada", time, index: steps.count))
            case ("log", "agent.stop"), ("log", "subagent.stop"):
                var step = note(e, e.name == "agent.stop" ? "El agente terminó" : "El subagente terminó", time, index: steps.count)
                step.subtitle = e.attr("ia.stop.reason")
                append(step)
            case ("log", _):
                // `[workspace] fetch {"taskId":…}`: el JSON del final va al detalle, no al título
                let text = message(e.name)
                var step = note(e, text, time, index: steps.count)
                if let m = text.firstMatch(#"^(.*?)\s+(\{.*\})\s*$"#) { step.title = m[0]; step.result = m[1] }
                append(step)
            default:
                continue
            }
        }
        if !running {
            for i in steps.indices where steps[i].state == .running { steps[i].state = .ok }
        }
        // en orden de inicio: el host manda algunos spans recién al terminar la corrida (un Bash del minuto 1 llega
        // al final); a igual hora, el orden en que llegaron
        return steps.enumerated().sorted { a, b in
            a.element.at == b.element.at ? a.offset < b.offset : a.element.at < b.element.at
        }.map(\.element)
    }

    private static func tool(_ key: String, _ name: String, _ time: String) -> RunStep {
        RunStep(id: key, kind: .tool, state: .running, title: toolTitle(name), time: time, tool: name)
    }

    private static func stage(_ e: TraceEntry, _ time: String) -> RunStep {
        RunStep(id: e.span_id, kind: .stage, state: .running, title: stageTitle(e.name), time: time, origin: e.origin)
    }

    /// `agent frontend-implementer` → `Agente frontend-implementer`.
    static func stageTitle(_ name: String) -> String {
        let labels = ["pipeline": "Pipeline", "agent": "Agente", "action": "Acción", "step": "Paso", "pause": "Pausa",
                      "host.run": "Corrida en el host:"]
        guard let space = name.firstIndex(of: " "), let label = labels[String(name[..<space])] else { return name }
        return label + name[space...]
    }

    private static func note(_ e: TraceEntry, _ title: String, _ time: String, index: Int) -> RunStep {
        let state: RunStep.State = e.level == "error" ? .failed : e.level == "warn" || title.contains(" warn]") ? .warn : .info
        return RunStep(id: "\(e.span_id)-note-\(index)", kind: .note, state: state, title: title, time: time, origin: e.origin)
    }

    /// Sin el id de la ejecución al principio (`0f81…-… abre: build-reentry` → `abre: build-reentry`).
    static func message(_ name: String) -> String {
        if let m = name.firstMatch(#"^[0-9a-f]{8}-[0-9a-f-]{27}\s+(.*)$"#) { return m[0] }
        return name
    }

    /// `mcp__ia-flow__submit_done` → `submit_done`: el mismo nombre que ve el runner.
    static func bareTool(_ name: String) -> String {
        name.hasPrefix("mcp__") ? (name.components(separatedBy: "__").last ?? name) : name
    }

    /// `mcp__github__get_issue` → `github · get_issue`.
    static func toolTitle(_ name: String) -> String {
        if name.hasPrefix("mcp__") {
            let parts = name.dropFirst(5).components(separatedBy: "__")
            return parts.joined(separator: " · ")
        }
        return name
    }

    /// Lo que identifica una llamada de un vistazo: la descripción o el comando de un Bash, el archivo de un Read o
    /// un Edit, el patrón de un Grep, el link de un WebFetch; si no, el primer texto del input.
    static func summary(tool: String, input: String?) -> String? {
        guard let input, !input.isEmpty else { return nil }
        let fields = jsonFields(input)
        func field(_ key: String) -> String? { fields[key] ?? input.firstMatch("\"\(key)\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)")?[0].unescaped }
        switch tool {
        case "Bash": return field("description") ?? field("command")
        case "Read", "Edit", "Write", "MultiEdit", "NotebookEdit": return field("file_path").map(shortPath)
        case "Grep", "Glob": return field("pattern").map { p in field("path").map { "\(p) en \(shortPath($0))" } ?? p }
        case "WebFetch": return field("url")
        case "WebSearch": return field("query")
        case "TodoWrite": return "Actualiza su lista de pasos"
        case "Task", "Agent": return field("description")
        default:
            // un MCP de GitHub: el repo y el número; si no, el primer campo que suele decir de qué se trata
            if let owner = fields["owner"], let repo = fields["repo"] {
                let number = fields["issue_number"] ?? fields["pull_number"] ?? fields["number"]
                return "\(owner)/\(repo)" + (number.map { "#\($0)" } ?? "") + (fields["method"].map { " · \($0)" } ?? "")
            }
            // un input largo llega cortado (no es JSON): `field` lo saca igual con regex, también anidado
            let preferred = ["description", "title", "query", "q", "path", "file_path", "url", "name", "pattern", "ref",
                             "summary", "entityName", "message"]
            return preferred.lazy.compactMap { field($0) }.map { firstLine($0) ?? $0 }.first { !$0.isEmpty }
                ?? fields.keys.sorted().lazy.compactMap { fields[$0] }.first { !$0.isEmpty && $0.count < 200 }
        }
    }

    /// El comando de un Bash, para mostrarlo bajo la descripción.
    static func command(input: String?) -> String? {
        guard let input else { return nil }
        return jsonFields(input)["command"] ?? input.firstMatch(#""command"\s*:\s*"((?:[^"\\]|\\.)*)"#)?[0].unescaped
    }

    /// El resultado de una tool como se lee: el stdout y el stderr de un Bash, el texto de un bloque, o tal cual.
    static func readable(_ result: String) -> String {
        guard let data = result.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) else { return result }
        if let o = json as? [String: Any] {
            let out = [o["stdout"] as? String, (o["stderr"] as? String).flatMap { $0.isEmpty ? nil : "stderr:\n\($0)" }]
                .compactMap { $0 }.filter { !$0.isEmpty }
            if !out.isEmpty { return out.joined(separator: "\n") }
            if let text = o["text"] as? String ?? o["content"] as? String ?? o["output"] as? String { return text }
            if let file = o["file"] as? [String: Any], let content = file["content"] as? String { return content }
        }
        if let blocks = json as? [[String: Any]] {
            let texts = blocks.compactMap { $0["text"] as? String }
            if !texts.isEmpty { return texts.joined(separator: "\n") }
        }
        if let pretty = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys]),
           let text = String(data: pretty, encoding: .utf8) { return text }
        return result
    }

    /// Los campos de texto de primer nivel de un input en JSON (vacío si no es JSON: un input largo llega cortado).
    private static func jsonFields(_ text: String) -> [String: String] {
        guard let data = text.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return o.compactMapValues { value in
            if let text = value as? String { return text }
            if let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() { return number.stringValue }
            return nil
        }
    }

    private static func shortPath(_ path: String) -> String {
        let parts = path.split(separator: "/")
        return parts.count > 2 ? "…/" + parts.suffix(2).joined(separator: "/") : path
    }

    private static func firstLine(_ text: String?) -> String? {
        text?.split(whereSeparator: \.isNewline).first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            .map { String($0).trimmingCharacters(in: CharacterSet(charactersIn: "# ")) }
    }

    private static let clockFormat: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func date(_ iso: String) -> Date? { isoFractional.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) }

    /// La hora local de un timestamp ISO (`HH:mm:ss`).
    static func clock(_ iso: String) -> String { date(iso).map(clockFormat.string(from:)) ?? String(iso.dropFirst(11).prefix(8)) }

    /// `850 ms`, `12 s`, `3 min 4 s`, `1 h 2 min`.
    static func duration(_ ms: Double) -> String {
        if ms < 1000 { return "\(Int(ms)) ms" }
        let s = Int(ms / 1000)
        if s < 60 { return "\(s) s" }
        if s < 3600 { return s % 60 == 0 ? "\(s / 60) min" : "\(s / 60) min \(s % 60) s" }
        return "\(s / 3600) h \(s % 3600 / 60) min"
    }
}

private extension String {
    /// Un string de JSON sacado con regex: sin los escapes.
    var unescaped: String {
        (try? JSONSerialization.jsonObject(with: Data("\"\(self)\"".utf8), options: .fragmentsAllowed) as? String) ?? self
    }
}
