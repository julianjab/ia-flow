import Foundation

// La búsqueda en GitHub del buscador: issues y PRs de toda la organización, estén o no en el board del runner. Sólo
// lee, con tu login de GitHub (el token del device flow), directo contra api.github.com: no pasa por el runner ni
// toca el board. Cada resultado sólo se abre en el navegador.

struct GithubIssue: Identifiable, Hashable {
    let ref: String
    let title: String
    let url: String
    let open: Bool
    let isPR: Bool
    let updatedAt: String
    var id: String { ref }
}

private struct GithubError: Decodable { let message: String? }

private struct SearchPage: Decodable { let items: [IssueBody] }

private struct IssueBody: Decodable {
    struct Pull: Decodable { let html_url: String? }
    let number: Int
    let title: String
    let html_url: String
    let state: String
    let updated_at: String
    let repository_url: String
    let pull_request: Pull?

    var issue: GithubIssue? {
        // https://api.github.com/repos/<owner>/<repo>
        let parts = repository_url.split(separator: "/").suffix(2)
        guard parts.count == 2 else { return nil }
        return GithubIssue(ref: "\(parts.first!)/\(parts.last!)#\(number)", title: title, url: html_url,
                           open: state == "open", isPR: pull_request != nil, updatedAt: updated_at)
    }
}

struct GithubSearch {
    let token: String

    /// Issues por texto en el título (lo más reciente primero), en toda la organización o en un repo.
    func search(_ text: String, org: String, repo: String?) async throws -> [GithubIssue] {
        let scope = repo.map { "repo:\(org)/\($0)" } ?? "org:\(org)"
        // GitHub exige `is:issue` o `is:pull-request` (no los dos): se buscan issues; un PR se encuentra por su ref.
        let q = "\(text) \(scope) in:title is:issue"
        var components = URLComponents(string: "https://api.github.com/search/issues")!
        components.queryItems = [.init(name: "q", value: q), .init(name: "sort", value: "updated"), .init(name: "per_page", value: "8")]
        let page: SearchPage = try await get(components.url!)
        return page.items.compactMap(\.issue)
    }

    /// Los repos de la organización que se pueden ver, del de actividad más reciente al más viejo (hasta 300).
    func repos(org: String) async throws -> [String] {
        struct Repo: Decodable { let name: String; let archived: Bool }
        var names: [String] = []
        for page in 1...3 {
            let url = URL(string: "https://api.github.com/orgs/\(org)/repos?per_page=100&sort=pushed&page=\(page)")!
            let batch: [Repo] = try await get(url)
            names += batch.filter { !$0.archived }.map(\.name)
            if batch.count < 100 { break }
        }
        return names
    }

    /// El mismo número en varios repos, en paralelo: los que existen y se pueden ver.
    func issues(number: Int, owner: String, repos: [String]) async -> [GithubIssue] {
        await withTaskGroup(of: GithubIssue?.self) { group in
            for repo in repos { group.addTask { try? await issue("\(owner)/\(repo)#\(number)") } }
            var found: [GithubIssue] = []
            for await issue in group { if let issue { found.append(issue) } }
            return found.sorted { $0.updatedAt > $1.updatedAt }
        }
    }

    /// Un issue o PR por su ref; nil si no existe o no se puede ver.
    func issue(_ ref: String) async throws -> GithubIssue? {
        guard let parts = RunnerSearch.split(ref),
              let url = URL(string: "https://api.github.com/repos/\(parts.owner)/\(parts.repo)/issues/\(parts.number)") else { return nil }
        do {
            let body: IssueBody = try await get(url)
            return body.issue
        } catch let error as RunnerError where error.status == 404 {
            return nil
        }
    }

    private func get<T: Decodable>(_ url: URL) async throws -> T {
        var req = URLRequest(url: url, timeoutInterval: 15)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "accept")
        req.setValue("2022-11-28", forHTTPHeaderField: "x-github-api-version")
        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw RunnerError(status: status, message: (try? JSONDecoder().decode(GithubError.self, from: data))?.message ?? "GitHub: HTTP \(status)")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
