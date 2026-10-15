import Foundation

// El estado de un runner, armado con lo que ya expone: `/health` (la probe de k8s; acá también la latencia),
// `/api/runner` (versión, asistente), `/api/webhooks/status` (qué escucha, el secreto, cuántas ejecuciones),
// `/api/ingress` (de dónde llegan eventos y cuándo llegó el último) y los avisos recientes de `/api/logs`.
// `issues` decide qué está mal: puro, sin red.

struct WebhookStatus: Decodable {
    struct Project: Decodable { let id: String; let board: String? }
    struct Executions: Decodable { let running: Int; let waiting: Int; let paused: Int }
    let endpoint: String?
    let secretConfigured: Bool?
    let projects: [Project]?
    let listening: [String]?
    let executions: Executions?
}

struct IngressSource: Decodable, Identifiable {
    let id: String
    let name: String
    let kind: String
    let endpoint: String?
    let configured: Bool
    let missing: String?
    let last_at: String?
    let count_24h: Int
    let count_kept: Int
}

struct IngressInfo: Decodable {
    let retention_days: Int
    let sources: [IngressSource]
}

/// `GET /api/resources` (`RunnerResourcesSchema`).
struct ResourceUsage: Decodable {
    let used_bytes: Double
    let total_bytes: Double
    var path: String? = nil
    var source: String? = nil
    var ratio: Double { total_bytes > 0 ? used_bytes / total_bytes : 0 }
}

struct MachineResources: Decodable {
    struct Load: Decodable { let load1: Double; let cpus: Double }
    let at: String
    let memory: ResourceUsage?
    let process_rss_bytes: Double?
    let disk: ResourceUsage?
    let load: Load?
    let worktrees: Int?
}

struct HostResources: Decodable, Identifiable {
    let name: String
    let provider: String
    let max_concurrent: Int
    let running: Int
    let last_seen: String
    let resources: MachineResources?
    var id: String { name }
    var full: Bool { running >= max_concurrent }
}

struct RunnerResources: Decodable {
    let runner: MachineResources
    let hosts: [HostResources]
}

struct RunnerHealth {
    var checkedAt = Date()
    /// `/health` contestó `ok`.
    var alive = false
    var latencyMs: Int?
    var failure: String?
    var info: RunnerInfo?
    var webhooks: WebhookStatus?
    var ingress: IngressInfo?
    /// nil = no se sabe; false = el runner es anterior a `/api/logs`.
    var logsExposed: Bool?
    /// Los últimos warn/error del log del proceso.
    var problems: [RunnerLogLine] = []
    /// Memoria, disco, worktrees del runner y sus hosts; nil si el runner es anterior a `/api/resources`.
    var resources: RunnerResources?
    var resourcesExposed: Bool?

    struct Issue: Identifiable {
        let tone: Tone
        let text: String
        var id: String { text }
    }

    /// Memoria o disco al 80 % avisa; al 90 %, problema (el pod lo mata el OOM, un disco lleno corta los clones).
    private static func machineIssues(_ machine: MachineResources, name: String) -> [Issue] {
        var list: [Issue] = []
        for (label, usage) in [("memoria", machine.memory), ("disco", machine.disk)] {
            guard let usage, usage.ratio >= 0.8 else { continue }
            list.append(Issue(tone: usage.ratio >= 0.9 ? .bad : .warn, text: "\(name): \(label) al \(Int(usage.ratio * 100)) %"))
        }
        if let load = machine.load, load.cpus > 0, load.load1 / load.cpus >= 1.5 {
            list.append(Issue(tone: .warn, text: "\(name): carga \(String(format: "%.1f", load.load1)) con \(formatCpus(load.cpus)) CPU"))
        }
        return list
    }

    /// Algo está a tope: sin lugares (runner u host), o memoria/disco al 90 %.
    func saturated(pipeline: InboxPipeline?) -> Bool {
        if let free = pipeline?.free, free == 0 { return true }
        guard let resources else { return false }
        let machines = [resources.runner] + resources.hosts.compactMap(\.resources)
        return resources.hosts.contains { $0.full }
            || machines.contains { ($0.memory?.ratio ?? 0) >= 0.9 || ($0.disk?.ratio ?? 0) >= 0.9 }
    }

    /// Lo que está mal o falta, de lo más grave a lo menos. Vacío = todo bien.
    func issues(pipeline: InboxPipeline?, now: Date = Date()) -> [Issue] {
        var list: [Issue] = []
        if !alive { list.append(Issue(tone: .bad, text: "No responde: \(failure ?? "sin respuesta de /health")")) }
        if webhooks?.secretConfigured == false {
            list.append(Issue(tone: .bad, text: "Sin secreto de webhook: GitHub no puede entregar eventos"))
        }
        if let github = ingress?.sources.first(where: { $0.id == "github" }), github.configured {
            if let last = github.last_at.flatMap(RunTrace.date) {
                let minutes = Int(now.timeIntervalSince(last) / 60)
                if minutes >= 120 { list.append(Issue(tone: .warn, text: "No llega nada de GitHub hace \(ago(github.last_at!, now: now) ?? "\(minutes) min")")) }
            } else {
                list.append(Issue(tone: .warn, text: "Todavía no llegó ningún evento de GitHub"))
            }
        }
        if let pipeline, pipeline.free == 0, pipeline.queued > 0 {
            list.append(Issue(tone: .warn, text: "Sin lugar libre: \(pipeline.queued) en cola"))
        }
        if let resources {
            list += Self.machineIssues(resources.runner, name: "El runner")
            for host in resources.hosts {
                if let seen = RunTrace.date(host.last_seen), now.timeIntervalSince(seen) > 120 {
                    list.append(Issue(tone: .bad, text: "\(host.name) no da señales hace \(ago(host.last_seen, now: now) ?? "rato")"))
                } else if host.full, (pipeline?.queued ?? 0) > 0 {
                    list.append(Issue(tone: .warn, text: "\(host.name) a tope (\(host.running)/\(host.max_concurrent)) con trabajo en cola"))
                }
                if let machine = host.resources { list += Self.machineIssues(machine, name: host.name) }
            }
        }
        let errors = problems.filter { $0.level == "error" }.count
        if errors > 0 { list.append(Issue(tone: .warn, text: "\(errors) error\(errors == 1 ? "" : "es") en el log reciente")) }
        if resourcesExposed == false {
            list.append(Issue(tone: .info, text: "Este runner no expone /api/resources: actualízalo para ver memoria, disco y worktrees"))
        }
        if logsExposed == false { list.append(Issue(tone: .info, text: "Este runner no expone /api/logs: actualízalo para ver sus errores")) }
        return list
    }
}

extension RunnerClient {
    /// Todo junto: cada parte que falle queda vacía; sólo `/health` decide si responde.
    func health() async -> RunnerHealth {
        var health = RunnerHealth()
        let started = Date()
        do {
            struct Ok: Decodable { let ok: Bool }
            let ok = try JSONDecoder().decode(Ok.self, from: try await request("/health"))
            health.alive = ok.ok
            health.latencyMs = Int(Date().timeIntervalSince(started) * 1000)
        } catch {
            health.failure = (error as? RunnerError)?.message ?? error.localizedDescription
            return health
        }
        async let info: RunnerInfo? = try? get("/api/runner")
        async let webhooks: WebhookStatus? = try? get("/api/webhooks/status")
        async let ingress: IngressInfo? = try? get("/api/ingress")
        async let logs = problemLines()
        async let resources = resourcesOrMissing()
        health.info = await info
        health.webhooks = await webhooks
        health.ingress = await ingress
        (health.logsExposed, health.problems) = await logs
        (health.resourcesExposed, health.resources) = await resources
        health.checkedAt = Date()
        return health
    }

    private func resourcesOrMissing() async -> (Bool?, RunnerResources?) {
        do {
            let resources: RunnerResources = try await get("/api/resources")
            return (true, resources)
        } catch let error as RunnerError where error.status == 404 || error.status == 501 {
            return (false, nil)
        } catch {
            return (nil, nil)
        }
    }

    private func problemLines() async -> (Bool?, [RunnerLogLine]) {
        do {
            let page: RunnerLogs = try await get("/api/logs?level=warn&limit=8")
            return (true, page.lines)
        } catch let error as RunnerError where error.status == 404 || error.status == 501 {
            return (false, [])
        } catch {
            return (nil, [])
        }
    }
}

/// `1.5` → `1.5`, `2.0` → `2`.
func formatCpus(_ cpus: Double) -> String { cpus.rounded() == cpus ? String(Int(cpus)) : String(format: "%.1f", cpus) }

/// `1.2 GB`, `512 MB`.
func formatBytes(_ bytes: Double) -> String {
    let gb = bytes / 1_073_741_824
    if gb >= 1 { return String(format: gb >= 10 ? "%.0f GB" : "%.1f GB", gb) }
    return String(format: "%.0f MB", bytes / 1_048_576)
}

extension RunnerHealth {
    /// Un estado de ejemplo para las capturas.
    static var fixture: RunnerHealth {
        func decode<T: Decodable>(_ json: String) -> T? { try? JSONDecoder().decode(T.self, from: Data(json.utf8)) }
        let recent = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-90))
        var health = RunnerHealth()
        health.alive = true
        health.latencyMs = 84
        health.info = RunnerInfo(version: "2.10.1", assistant: true,
                                 assistant_agents: [.init(id: "assistant", label: "Operación"), .init(id: "improvements", label: "Mejoras del runner")])
        health.webhooks = decode(#"{"endpoint":"/api/webhooks/github","secretConfigured":true,"projects":[{"id":"lahaus-ai-flow","board":"la-haus#119"}],"listening":["github.check_suite","github.issue_comment","github.issues","github.projects_v2_item","github.pull_request","github.pull_request_review","github.workflow_run","slack.message"],"executions":{"running":2,"waiting":0,"paused":1}}"#)
        health.ingress = decode(#"{"retention_days":14,"sources":[{"id":"github","name":"GitHub","kind":"webhook","configured":true,"last_at":"\#(recent)","count_24h":6486,"count_kept":51090},{"id":"slack","name":"Slack","kind":"socket","configured":false,"missing":"SLACK_APP_TOKEN","count_24h":0,"count_kept":0}]}"#)
        health.logsExposed = true
        health.resourcesExposed = true
        health.resources = decode(#"""
        {"runner":{"at":"\#(recent)","memory":{"used_bytes":1288490188,"total_bytes":2147483648,"source":"cgroup"},"process_rss_bytes":402653184,
          "disk":{"path":"/state","used_bytes":8589934592,"total_bytes":21474836480},"load":{"load1":0.4,"cpus":1},"worktrees":0},
         "hosts":[{"name":"front-end-developer","provider":"remote:front-end-developer","max_concurrent":2,"running":2,"last_seen":"\#(recent)",
           "resources":{"at":"\#(recent)","memory":{"used_bytes":7301444403,"total_bytes":8589934592,"source":"cgroup"},
             "disk":{"path":"/state/host-workspaces","used_bytes":40802189312,"total_bytes":53687091200},"load":{"load1":2.6,"cpus":2},"worktrees":7}},
          {"name":"e2e","provider":"remote:e2e","max_concurrent":1,"running":0,"last_seen":"\#(recent)"}]}
        """#)
        health.problems = [
            RunnerLogLine(seq: 1, time: "2026-10-15T22:40:01.000Z", level: "warn", scope: "github", message: "rate limit bajo: 312 restantes", fields: nil, trace_id: nil),
            RunnerLogLine(seq: 2, time: "2026-10-15T22:41:40.000Z", level: "error", scope: "provider", message: "timeout esperando al modelo", fields: "task=#4301", trace_id: nil),
        ]
        return health
    }
}
