import Foundation

// El buscador de la pestaña Runner: interpreta lo que se escribe (un número, `repo#n`, `owner/repo#n`, el link de un
// issue o PR de GitHub, o texto del título) y decide si una tarea coincide. Puro: sin red ni estado.

struct RunnerSearch: Equatable {
    var owner: String?
    var repo: String?
    var number: Int?
    /// Texto libre (sin número reconocible): se busca en el título y la ref.
    var text: String?

    /// `owner/repo#n` si lo que se escribió alcanza para pedir la tarea por su ref.
    var fullRef: String? {
        guard let owner, let repo, let number else { return nil }
        return "\(owner)/\(repo)#\(number)"
    }

    init?(_ raw: String) {
        let q = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return nil }
        // https://github.com/owner/repo/issues/12, /pull/12, con o sin #comentario
        if let m = q.firstMatch(#"github\.com/([^/\s]+)/([^/\s]+)/(?:issues|pull)/(\d+)"#) {
            owner = m[0]; repo = m[1]; number = Int(m[2]); return
        }
        // owner/repo#12, owner/repo 12
        if let m = q.firstMatch(#"^([\w.-]+)/([\w.-]+)\s*[#\s]\s*(\d+)$"#) {
            owner = m[0]; repo = m[1]; number = Int(m[2]); return
        }
        // repo#12, repo 12
        if let m = q.firstMatch(#"^([A-Za-z][\w.-]*)\s*[#\s]\s*(\d+)$"#) {
            repo = m[0]; number = Int(m[1]); return
        }
        // 12, #12
        if let m = q.firstMatch(#"^#?(\d+)$"#) {
            number = Int(m[0]); return
        }
        text = q.lowercased()
    }

    /// `owner/repo#n` coincide si el número es el mismo —el del issue o el de su PR, así sirve pegar el link del
    /// PR— y el repo (y el owner, si se dio) también; el texto, por título o ref.
    func matches(ref: String, title: String, pr: Int? = nil) -> Bool {
        if let text {
            return title.lowercased().contains(text) || ref.lowercased().contains(text) || cleanTitle(title).lowercased().contains(text)
        }
        guard let parts = RunnerSearch.split(ref) else { return false }
        if let number, parts.number != number, pr != number { return false }
        if let repo, parts.repo.lowercased() != repo.lowercased() { return false }
        if let owner, parts.owner.lowercased() != owner.lowercased() { return false }
        return true
    }

    static func split(_ ref: String) -> (owner: String, repo: String, number: Int)? {
        guard let m = ref.firstMatch(#"^([^/]+)/([^#]+)#(\d+)$"#), let n = Int(m[2]) else { return nil }
        return (m[0], m[1], n)
    }
}

extension String {
    /// Los grupos de la primera coincidencia de `pattern`, o nil.
    func firstMatch(_ pattern: String) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let match = regex.firstMatch(in: self, range: NSRange(startIndex..., in: self)) else { return nil }
        return (1..<match.numberOfRanges).map { i in
            Range(match.range(at: i), in: self).map { String(self[$0]) } ?? ""
        }
    }
}
