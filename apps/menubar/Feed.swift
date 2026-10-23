import Foundation

// Lo que mueve cards en el board desde el menú: las de Todo («Próximo», `feed` de la bandeja) a otra columna, y
// un issue de GitHub que no está en el board, adentro. Las columnas salen de `projects[].statuses`; las dos cosas se
// firman con tu login, como las acciones de una tarea (RunnerModel.signed).

extension FeedItem {
    var displayTitle: String { cleanTitle(title) }
    /// `#123` (el repo va en el tag).
    var shortRef: String { ref.split(separator: "#").last.map { "#\($0)" } ?? ref }
    var age: String? { updated_at.flatMap { ago($0) } }

    /// A quién espera: `#12` si es del mismo repo, `repo#12` si no.
    var waitingFor: [String] {
        let mine = RunnerSearch.split(ref)?.repo
        return (blocked_by ?? []).map { blocker in
            guard let parts = RunnerSearch.split(blocker) else { return blocker }
            return parts.repo == mine ? "#\(parts.number)" : "\(parts.repo)#\(parts.number)"
        }
    }
}

extension RunnerModel {
    /// Las cards de Todo que muestra Próximo: el repo del tag y lo que se busca.
    var shownFeed: (ready: [FeedItem], waiting: [FeedItem]) {
        let keep = { (item: FeedItem) in
            self.inRepo(item.ref) && (self.search?.matches(ref: item.ref, title: item.title) ?? true)
        }
        return ((inbox?.feed?.ready ?? []).filter(keep), (inbox?.feed?.waiting ?? []).filter(keep))
    }

    var projects: [InboxProject] { inbox?.projects ?? [] }

    /// Las columnas del proyecto (el primero si la card no dice de cuál); vacío con un runner viejo.
    func statuses(project id: String?) -> [String] {
        (projects.first { $0.id == id } ?? projects.first)?.statuses ?? []
    }

    /// A dónde se puede mover una card de Todo: las columnas de su proyecto menos la suya.
    func destinations(_ item: FeedItem) -> [String] {
        destinations(ref: item.ref, project: item.project_id, status: item.status)
    }

    /// Las columnas del proyecto de una card menos la suya.
    func destinations(ref: String, project: String?, status: String?) -> [String] {
        statuses(project: project).filter { $0.caseInsensitiveCompare(status ?? "") != .orderedSame }
    }

    func open(_ item: FeedItem) { openTask(item.ref) }

    /// Mover sale directo (es elegir en un menú); 409 si un agente la trabaja o ya está ahí: el runner lo dice.
    func move(_ item: FeedItem, to status: String) { move(ref: item.ref, to: status) }

    func move(ref: String, to status: String) {
        guard !isFixture else { return }
        Task { @MainActor in
            await signed(ref, what: "mover la card", okPrefix: "✓ \(shortRef(ref)) movida a \(status)") { client, token in
                await client.move(ref: ref, to: status, github: token)
            }
        }
    }

    /// Agrega un issue al board (Todo si no se elige columna) con tu login; sale de «En los repos, sin card».
    func addToBoard(ref: String, project: String?, status: String?, done: ((AddToBoardResult) -> Void)? = nil) {
        guard !isFixture else { return }
        Task { @MainActor in
            let result = await signed(ref, what: "agregar al board") { client, token in
                await client.addToBoard(issue: ref, projectId: project, status: status, github: token)
            }
            guard let result else { return }
            done?(result)
            guard result.ok else { return }
            forgetBoard()
            warmNext()
        }
    }

    /// Las cards de Todo de Próximo: el proyecto elegido, el repo del tag y lo que se busca.
    var nextFeed: (ready: [FeedItem], waiting: [FeedItem]) {
        let feed = shownFeed
        guard let project = nextProject else { return feed }
        return (feed.ready.filter { $0.project_id == project }, feed.waiting.filter { $0.project_id == project })
    }

    /// Las columnas del resto del board con sus cards (del proyecto elegido).
    var nextBoard: [BoardColumn] {
        guard let project = nextProject else { return boardColumns }
        return boardColumns.map { BoardColumn(status: $0.status, items: $0.items.filter { $0.project_id == nil || $0.project_id == project }) }
    }
}
