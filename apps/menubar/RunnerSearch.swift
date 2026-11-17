import Foundation

// El buscador de la pestaña Runner: interpreta lo que se escribe (un número, `repo#n`, `owner/repo#n`, el link de un
// issue o PR de GitHub, o texto del título) y decide si una tarea coincide. Puro: sin red ni estado.

struct RunnerSearch: Equatable {
    var owner: String?
    var repo: String?
    var number: Int?
    /// Texto libre (sin número reconocible), en palabras normalizadas: se busca aproximado en el título y la ref.
    var text: String?
    private var words: [String] = []

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
        words = RunnerSearch.words(q)
    }

    /// `owner/repo#n` coincide si el número es el mismo —el del issue o el de su PR, así sirve pegar el link del
    /// PR— y el repo (y el owner, si se dio) también; el texto, por título o ref.
    func matches(ref: String, title: String, pr: Int? = nil) -> Bool {
        if text != nil {
            let haystack = RunnerSearch.haystack(ref: ref, title: title)
            return !words.isEmpty && words.allSatisfy { word in haystack.contains { RunnerSearch.close(word, $0) } }
        }
        guard let parts = RunnerSearch.split(ref) else { return false }
        if let number, parts.number != number, pr != number { return false }
        if let repo, parts.repo.lowercased() != repo.lowercased() { return false }
        if let owner, parts.owner.lowercased() != owner.lowercased() { return false }
        return true
    }

    /// Las palabras de una tarea (su título y, del ref, sólo el repo: el owner —`la-haus`— está en todas y haría
    /// coincidir cualquier cosa). Se guardan: cada tecla las pedía otra vez para cada tarea de la bandeja y del board.
    static func haystack(ref: String, title: String) -> [String] {
        let key = "\(ref)\u{0}\(title)" as NSString
        if let cached = haystacks.object(forKey: key) { return cached.words }
        let words = RunnerSearch.words("\(title) \(split(ref)?.repo ?? ref)")
        haystacks.setObject(Words(words), forKey: key)
        return words
    }

    private final class Words {
        let words: [String]
        init(_ words: [String]) { self.words = words }
    }

    private static let haystacks: NSCache<NSString, Words> = {
        let cache = NSCache<NSString, Words>()
        cache.countLimit = 5000
        return cache
    }()

    /// Sin tildes ni mayúsculas, partido en palabras (`assignable_stages` → `assignable`, `stages`).
    static func words(_ text: String) -> [String] {
        text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
            .lowercased()
            .split { !$0.isLetter && !$0.isNumber }
            .map(String.init)
    }

    /// La palabra buscada aparece en la del título (prefijo o adentro, desde 3 letras) o está a un typo de ella:
    /// 1 letra de diferencia en palabras de 4 a 6, 2 desde 7.
    static func close(_ word: String, _ candidate: String) -> Bool {
        if candidate == word || (word.count >= 3 && candidate.contains(word)) || (word.count < 3 && candidate.hasPrefix(word)) { return true }
        let allowed = word.count >= 7 ? 2 : word.count >= 4 ? 1 : 0
        guard allowed > 0, abs(candidate.count - word.count) <= allowed else {
            // «perfil» contra «perfilado»: el typo puede estar en el prefijo de una palabra más larga
            return allowed > 0 && candidate.count > word.count && distance(word, String(candidate.prefix(word.count))) <= allowed
        }
        return distance(word, candidate) <= allowed
    }

    /// Distancia de Levenshtein (palabras cortas: alcanza con la tabla de dos filas).
    static func distance(_ a: String, _ b: String) -> Int {
        let a = Array(a), b = Array(b)
        if a.isEmpty { return b.count }
        if b.isEmpty { return a.count }
        var previous = Array(0...b.count)
        for i in 1...a.count {
            var current = [i] + Array(repeating: 0, count: b.count)
            for j in 1...b.count {
                current[j] = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1))
            }
            previous = current
        }
        return previous[b.count]
    }

    static func split(_ ref: String) -> (owner: String, repo: String, number: Int)? {
        guard let m = ref.firstMatch(#"^([^/]+)/([^#]+)#(\d+)$"#), let n = Int(m[2]) else { return nil }
        return (m[0], m[1], n)
    }
}

/// Los regex ya compilados, por patrón: compilar un `NSRegularExpression` cuesta mucho más que usarlo, y el buscador
/// los pedía varias veces por tarea en cada tecla. Con candado: también se usan fuera del hilo principal.
private enum RegexCache {
    private static var compiled: [String: NSRegularExpression] = [:]
    private static let lock = NSLock()

    static func regex(_ pattern: String) -> NSRegularExpression? {
        lock.lock()
        defer { lock.unlock() }
        if let regex = compiled[pattern] { return regex }
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return nil }
        // los patrones con datos adentro (RunTrace arma uno por campo) no deben crecer sin fin
        if compiled.count > 200 { compiled.removeAll() }
        compiled[pattern] = regex
        return regex
    }
}

extension String {
    /// Los grupos de la primera coincidencia de `pattern`, o nil.
    func firstMatch(_ pattern: String) -> [String]? {
        guard let regex = RegexCache.regex(pattern),
              let match = regex.firstMatch(in: self, range: NSRange(startIndex..., in: self)) else { return nil }
        return (1..<match.numberOfRanges).map { i in
            Range(match.range(at: i), in: self).map { String(self[$0]) } ?? ""
        }
    }
}
