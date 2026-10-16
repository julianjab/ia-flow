import Foundation

// El estado de la pantalla «GitHub»: buscar issues y PRs en cualquier repo de la organización, estén o no en el board
// del runner. Busca con tu login de GitHub, directo contra api.github.com (GithubSearch); un issue que no está en el
// board se puede agregar (eso sí pasa por el runner, `POST /api/board/items`). Aparte de la bandeja a propósito: el
// buscador de la pestaña Runner es sólo del runner.

final class GithubSearchModel: ObservableObject {
    /// Lo que se escribe: texto, un número (con un repo elegido), `repo#n`, `owner/repo#n` o el link de GitHub.
    @Published var query = "" { didSet { if query != oldValue { schedule() } } }
    /// El repo donde se busca (sólo el nombre); nil = toda la organización.
    @Published var repo: String? {
        didSet {
            guard repo != oldValue else { return }
            if !isFixture { UserDefaults.standard.set(repo, forKey: "githubRepo:\(org)") }
            schedule()
        }
    }
    /// El filtro de la lista de repos (son cientos).
    @Published var repoFilter = ""
    @Published var pickingRepo = false
    /// Los repos de la organización que ve tu login, del de actividad más reciente al más viejo.
    @Published private(set) var repos: [String] = []
    @Published private(set) var results: [GithubIssue] = []
    /// Por qué no hay resultados que mostrar (sin login, falta elegir repo, un error de GitHub).
    @Published private(set) var note: String?
    @Published private(set) var needsLogin = false
    @Published private(set) var searching = false
    @Published private(set) var loadingRepos = false
    /// Los que se agregaron al board desde acá (ref en minúsculas → columna): la fila lo muestra sin esperar al board.
    @Published private(set) var added: [String: String] = [:]

    let org: String
    unowned let runner: RunnerModel
    private let isFixture: Bool
    private var searchTask: Task<Void, Never>?
    private var reposAt: Date?

    init(org: String, runner: RunnerModel, isFixture: Bool = false) {
        self.org = org
        self.runner = runner
        self.isFixture = isFixture
        repo = isFixture ? nil : UserDefaults.standard.string(forKey: "githubRepo:\(org)")
    }

    /// Los del board primero (son los de todos los días), después el resto por actividad; filtrados por lo que se
    /// escribió (sin mayúsculas, en cualquier parte del nombre).
    var shownRepos: (board: [String], others: [String]) {
        let filter = repoFilter.trimmingCharacters(in: .whitespaces).lowercased()
        let matches = { (name: String) in filter.isEmpty || name.lowercased().contains(filter) }
        let board = runner.repos.map(\.name)
        let boardSet = Set(board.map { $0.lowercased() })
        return (board.filter(matches), repos.filter { !boardSet.contains($0.lowercased()) && matches($0) })
    }

    /// Lo que va a hacer la búsqueda con lo escrito (para el placeholder y la ayuda).
    var placeholder: String {
        repo.map { "Número o texto en \($0)" } ?? "Texto, repo#número o link de GitHub"
    }

    func appear() {
        loadRepos()
        runner.warmBoard()
        if !query.isEmpty, results.isEmpty, note == nil { schedule() }
    }

    func select(_ name: String?) {
        repo = name
        pickingRepo = false
        repoFilter = ""
    }

    /// La columna si ya está en el board («» si está y no se sabe en cuál); nil si no está (o no se sabe).
    func boardStatus(_ issue: GithubIssue) -> String? {
        let key = issue.ref.lowercased()
        return added[key] ?? runner.boardStatuses[key]
    }

    /// Lo agrega al board del runner (sin `status`, en Todo). Un 409 (ya está, o el repo no es del board) lo dice el
    /// runner en el toast.
    func add(_ issue: GithubIssue, project: String?, status: String?) {
        guard !isFixture else { return }
        Task { @MainActor in
            let result = await runner.signed(issue.ref, what: "agregar al board") { client, token in
                await client.addToBoard(issue: issue.ref, projectId: project, status: status, github: token)
            }
            guard let result, result.ok else { return }
            added[issue.ref.lowercased()] = result.status ?? status ?? "Todo"
            runner.forgetBoard()
            runner.warmBoard()
        }
    }

    /// Los repos, una vez por hora (con tu login).
    func loadRepos() {
        guard !isFixture, !loadingRepos else { return }
        if let at = reposAt, Date().timeIntervalSince(at) < 3600, !repos.isEmpty { return }
        loadingRepos = true
        Task { @MainActor in
            defer { loadingRepos = false }
            guard let session = await runner.validSession(),
                  let names = try? await GithubSearch(token: session.token).repos(org: org) else { return }
            repos = names
            reposAt = Date()
        }
    }

    /// Espera a que se deje de escribir (350 ms) y busca.
    private func schedule() {
        searchTask?.cancel()
        guard !isFixture else { return }
        let raw = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else {
            results = []; note = nil; searching = false
            return
        }
        let repo = repo
        searchTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard !Task.isCancelled else { return }
            searching = true
            defer { if !Task.isCancelled { searching = false } }
            let (found, message, login) = await run(raw, repo: repo)
            guard !Task.isCancelled, raw == query.trimmingCharacters(in: .whitespacesAndNewlines), repo == self.repo else { return }
            results = found
            note = message
            needsLogin = login
        }
    }

    /// Una ref (link, `owner/repo#n`, `repo#n`, o un número con un repo elegido) va directo a ese issue; un texto,
    /// a la búsqueda de GitHub. Un número sin repo NO prueba en todos los repos: pide elegir uno.
    private func run(_ raw: String, repo: String?) async -> ([GithubIssue], String?, Bool) {
        guard let search = RunnerSearch(raw) else { return ([], nil, false) }
        let ref: String? = {
            if let full = search.fullRef { return full }
            guard let number = search.number else { return nil }
            if let named = search.repo { return "\(search.owner ?? org)/\(named)#\(number)" }
            return repo.map { "\(org)/\($0)#\(number)" }
        }()
        if ref == nil, let number = search.number {
            return ([], "Elige un repo para buscar #\(number): GitHub no busca por número en toda la organización.", false)
        }
        if ref == nil, (search.text?.count ?? 0) < 3 {
            return ([], "Escribe al menos 3 letras.", false)
        }
        guard let session = await runner.validSession() else {
            return ([], "Inicia sesión con GitHub para buscar en los repos de \(org).", true)
        }
        let github = GithubSearch(token: session.token)
        do {
            if let ref {
                guard let issue = try await github.issue(ref) else { return ([], "\(ref) no existe o tu login no lo puede ver.", false) }
                return ([issue], nil, false)
            }
            let found = try await github.search(search.text ?? "", org: org, repo: repo)
            return (found, found.isEmpty ? "Nada con «\(raw)» en \(repo ?? "toda \(org)")." : nil, false)
        } catch let error as RunnerError {
            return ([], "GitHub no respondió: \(error.message)", false)
        } catch {
            return ([], nil, false)
        }
    }
}

extension GithubSearchModel {
    /// Una búsqueda de ejemplo para las capturas: no llama a GitHub.
    static func fixture(runner: RunnerModel) -> GithubSearchModel {
        let model = GithubSearchModel(org: "la-haus", runner: runner, isFixture: true)
        model.repos = ["subscriptions", "lh-seller-v2-frontend", "claw-agents", "ims-backend", "eks", "ai-mobile-app", "conversations"]
        model.query = "filtros"
        model.results = [
            GithubIssue(ref: "la-haus/lh-seller-v2-frontend#4381", title: "El boton para mostrar filtros en Funnel y Leads esta desalineado",
                        url: "https://github.com", open: true, isPR: false, updatedAt: "2026-10-15T22:00:00Z"),
            GithubIssue(ref: "la-haus/lh-seller-v2-frontend#4397", title: "feat(360): filtros, badges, tags y timeline usan la etapa del funnel",
                        url: "https://github.com", open: true, isPR: false, updatedAt: "2026-10-15T18:00:00Z"),
            GithubIssue(ref: "la-haus/ai-mobile-app#63", title: "feat(screens): Búsqueda y filtros de conversaciones",
                        url: "https://github.com", open: false, isPR: false, updatedAt: "2026-09-02T12:00:00Z"),
            GithubIssue(ref: "la-haus/claw-agents#1855", title: "feat(pixelin): columna estado + reactivación + filtros",
                        url: "https://github.com", open: false, isPR: false, updatedAt: "2026-08-20T12:00:00Z"),
        ]
        return model
    }
}
