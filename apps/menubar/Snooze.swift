import Foundation

// Posponer, fijar y ordenar «Para mí» (fase 1 del SPEC: en el cliente, por runner). Las mismas reglas que
// `apps/web/src/features/inbox/queue/snooze.ts`:
// - Una pospuesta vuelve sola cuando cambia su huella (`status|since|execution.id|execution.status|pr.number|kind`)
//   o vence su plazo; mientras tanto no se muestra arriba ni cuenta en el badge.
// - Las fijadas van siempre primero, en el orden en que se fijaron; una que deja de necesitarte se desfija sola.
// - El orden: Prioridad (la del runner) · Más reciente · Más antigua (por `since`).
// La lógica es pura (`Triage`); `TriageStore` la guarda en `~/.config/ia-flow-menubar/snoozes.json` (respeta
// IA_FLOW_MENUBAR_HOME), un bloque por runner.

enum TriageOrder: String, Codable, CaseIterable {
    case priority, newest, oldest

    var title: String {
        switch self {
        case .priority: return "Prioridad"
        case .newest: return "Más reciente"
        case .oldest: return "Más antigua"
        }
    }
}

/// Hasta cuándo se pospone.
enum SnoozeLength: Equatable {
    case untilChange, day, week, date(Date)

    func until(from now: Date) -> Date? {
        switch self {
        case .untilChange: return nil
        case .day: return now.addingTimeInterval(86_400)
        case .week: return now.addingTimeInterval(7 * 86_400)
        case .date(let date): return date
        }
    }
}

struct SnoozeEntry: Codable, Equatable {
    let ref: String
    /// La huella de la tarea al posponerla: si cambia, vuelve.
    let fingerprint: String
    /// nil: hasta que cambie algo.
    var until: Date?
    let at: Date
}

struct PinEntry: Codable, Equatable {
    let ref: String
    let at: Date
}

/// Lo que se decidió sobre Para mí en un runner.
struct RunnerTriage: Codable, Equatable {
    var snoozed: [SnoozeEntry] = []
    var pinned: [PinEntry] = []
    var order: TriageOrder = .priority
}

enum Triage {
    /// Lo que, si cambia, devuelve una pospuesta: un commit, un review o el CI mueven alguno de estos.
    static func fingerprint(_ item: InboxItem) -> String {
        [item.status ?? "", item.since, item.execution?.id ?? "", item.execution?.status ?? "",
         item.pr.map { String($0.number) } ?? "", item.kind].joined(separator: "|")
    }

    /// La pospuesta vigente de la tarea, si la hay (misma huella y sin vencer).
    static func snooze(of item: InboxItem, in state: RunnerTriage, now: Date) -> SnoozeEntry? {
        state.snoozed.first { entry in
            entry.ref == item.ref && entry.fingerprint == fingerprint(item) && (entry.until.map { $0 > now } ?? true)
        }
    }

    static func isPinned(_ ref: String, in state: RunnerTriage) -> Bool { state.pinned.contains { $0.ref == ref } }

    /// Las que se muestran (fijadas primero, después según el orden) y las pospuestas (de la que vuelve antes a la que
    /// vuelve después; «hasta que cambie algo», al final).
    static func split(_ items: [InboxItem], state: RunnerTriage, now: Date) -> (shown: [InboxItem], snoozed: [InboxItem]) {
        let snoozed = items.filter { snooze(of: $0, in: state, now: now) != nil }
        let shown = items.filter { snooze(of: $0, in: state, now: now) == nil }
        let returning = snoozed.sorted {
            (snooze(of: $0, in: state, now: now)?.until ?? .distantFuture) < (snooze(of: $1, in: state, now: now)?.until ?? .distantFuture)
        }
        return (sorted(shown, order: state.order, pinned: state.pinned), returning)
    }

    /// Fijadas primero (en el orden en que se fijaron); el resto según `order`. Estable: a igual criterio, el del runner.
    static func sorted(_ items: [InboxItem], order: TriageOrder, pinned: [PinEntry]) -> [InboxItem] {
        let indexed = Array(items.enumerated())
        let base: [InboxItem] = indexed.sorted { a, b in
            switch order {
            case .priority:
                let pa = a.element.priority ?? .max, pb = b.element.priority ?? .max
                return pa != pb ? pa < pb : a.offset < b.offset
            case .newest, .oldest:
                let da = date(a.element.since), db = date(b.element.since)
                if da == db { return a.offset < b.offset }
                return order == .newest ? da > db : da < db
            }
        }.map(\.element)
        let pins = pinned.sorted { $0.at < $1.at }.map(\.ref)
        let top = pins.compactMap { ref in base.first { $0.ref == ref } }
        return top + base.filter { !pins.contains($0.ref) }
    }

    /// Sin lo que ya no vale: pospuestas que vencieron o cuya tarea cambió o dejó Para mí (si vuelve, vuelve a la
    /// vista), y fijadas que dejaron de necesitarte.
    static func pruned(_ state: RunnerTriage, decisions: [InboxItem], now: Date) -> RunnerTriage {
        var next = state
        let byRef = Dictionary(decisions.map { ($0.ref, $0) }, uniquingKeysWith: { a, _ in a })
        next.snoozed = state.snoozed.filter { entry in
            guard let item = byRef[entry.ref] else { return false }
            return entry.fingerprint == fingerprint(item) && (entry.until.map { $0 > now } ?? true)
        }
        next.pinned = state.pinned.filter { byRef[$0.ref] != nil }
        return next
    }

    static func snoozing(_ item: InboxItem, _ length: SnoozeLength, in state: RunnerTriage, now: Date) -> RunnerTriage {
        var next = unsnoozing(item.ref, in: state)
        next.snoozed.append(SnoozeEntry(ref: item.ref, fingerprint: fingerprint(item), until: length.until(from: now), at: now))
        // posponer una fijada la desfija: no puede estar arriba y escondida a la vez
        next.pinned.removeAll { $0.ref == item.ref }
        return next
    }

    static func unsnoozing(_ ref: String, in state: RunnerTriage) -> RunnerTriage {
        var next = state
        next.snoozed.removeAll { $0.ref == ref }
        return next
    }

    static func togglingPin(_ ref: String, in state: RunnerTriage, now: Date) -> RunnerTriage {
        var next = state
        if next.pinned.contains(where: { $0.ref == ref }) {
            next.pinned.removeAll { $0.ref == ref }
        } else {
            next.pinned.append(PinEntry(ref: ref, at: now))
            next.snoozed.removeAll { $0.ref == ref }
        }
        return next
    }

    private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func date(_ iso: String) -> Date {
        fractional.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) ?? .distantPast
    }
}

/// `snoozes.json`: `{"runners": {"<baseUrl>": RunnerTriage}}`.
enum TriageStore {
    private struct File: Codable { var runners: [String: RunnerTriage] = [:] }

    static var path: String { "\(configDir)/snoozes.json" }

    private static func read() -> File {
        guard let data = FileManager.default.contents(atPath: path) else { return File() }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode(File.self, from: data)) ?? File()
    }

    static func load(_ server: String) -> RunnerTriage { read().runners[server] ?? RunnerTriage() }

    static func save(_ triage: RunnerTriage, for server: String) {
        var file = read()
        file.runners[server] = triage
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try? FileManager.default.createDirectory(atPath: configDir, withIntermediateDirectories: true)
        if let data = try? encoder.encode(file) { FileManager.default.createFile(atPath: path, contents: data) }
    }
}
