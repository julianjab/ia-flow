import AVFoundation
import Speech
import SwiftUI

// La voz de los chats del asistente (la pestaña y «¿Por qué?» de una mejora): leer cada respuesta en voz alta al terminar
// (AVSpeechSynthesizer, con la mejor voz en español instalada) y dictar la pregunta (Speech, en el equipo si el idioma lo
// permite). Con la voz prendida el runner suma un resumen para el oído (`speech`), que se lee en vez de la respuesta.
// «Charla» encadena las dos: lee y vuelve a escuchar. Una sola voz y un solo micrófono para toda la app. Es el mismo
// recorte que la web (`apps/web/src/features/assistant/voice/`).

enum Speakable {
    /// El texto tal como se dice: sin bloques de código, tablas ni marcas de markdown; un link es «el enlace».
    static func text(_ markdown: String) -> String {
        var s = markdown.replacingOccurrences(of: "```[\\s\\S]*?(```|$)", with: " ", options: .regularExpression)
        s = s.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("|") }
            .map { $0.replacingOccurrences(of: "^\\s*(#{1,6}|[-*•]|\\d+[.)])\\s+", with: "", options: .regularExpression) }
            .joined(separator: "\n")
        s = s.replacingOccurrences(of: "https?://\\S+", with: "el enlace", options: .regularExpression)
            .replacingOccurrences(of: "[`*~]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// `markdown` listo para decir, en frases (cada una un utterance: se corta entre frases, no en el medio).
    static func parts(_ markdown: String) -> [String] {
        text(markdown)
            .replacingOccurrences(of: "([.!?…:])\\s+", with: "$1\n", options: .regularExpression)
            .split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
}

/// La palabra que envía lo dictado, como en la web (`apps/web/src/features/assistant/voice/command.ts`).
enum DictationCommand {
    static let sendWords: Set<String> = ["enviar", "envia", "envialo", "mandar", "manda", "mandalo", "listo"]
    /// Cuánto silencio, después de hablar, manda lo dictado (sin nada dicho, sólo apaga el micrófono).
    static let silence: TimeInterval = 4

    /// Si `text` termina en una palabra de envío: el texto sin ella. Si no, nil.
    static func withoutSendWord(_ text: String) -> String? {
        let trimmed = text.replacingOccurrences(of: "[\\s.,;!¡?¿]+$", with: "", options: .regularExpression)
        guard let range = trimmed.range(of: "\\p{L}+$", options: .regularExpression) else { return nil }
        let word = trimmed[range].folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil)
        let before = trimmed[..<range.lowerBound]
        guard sendWords.contains(word), before.isEmpty || before.last?.isWhitespace == true else { return nil }
        return before.trimmingCharacters(in: CharacterSet.whitespaces.union(CharacterSet(charactersIn: ",;:")))
    }
}

/// Lo dictado hasta ahora. El reconocimiento en el equipo (macOS 13+) reinicia la transcripción parcial después de una
/// pausa: sin juntar los tramos, decir «enviar» tras callarse dejaba sólo «enviar», la caja quedaba vacía y no se mandaba.
struct Transcript {
    private var committed = ""
    private var last = ""
    private var lastStart: TimeInterval = 0

    var text: String { [committed, last].filter { !$0.isEmpty }.joined(separator: " ") }

    /// `partial` es la transcripción que llegó; `start`, cuándo empieza su primer tramo (0 si no se sabe).
    mutating func update(_ partial: String, start: TimeInterval = 0) -> String {
        if Self.restarted(from: last, lastStart: lastStart, to: partial, start: start) {
            committed = text
        }
        last = partial
        lastStart = start
        return text
    }

    /// Un tramo nuevo, no una corrección del anterior: empieza más tarde en el audio, o es más corto y ya no arranca
    /// con la primera palabra de lo que había.
    static func restarted(from last: String, lastStart: TimeInterval, to partial: String, start: TimeInterval) -> Bool {
        guard !last.isEmpty else { return false }
        if start > lastStart + 0.5 { return true }
        let fold = { (s: String) in s.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil) }
        let firstWord = fold(last).split(separator: " ").first.map(String.init) ?? ""
        return partial.count < last.count && !fold(partial).hasPrefix(firstWord)
    }
}

/// Lee en voz alta: cada respuesta al terminar de llegar (si la voz o la charla están prendidas) y la que se pida con su
/// 🔊. En charla, al terminar de leer vuelve a escuchar.
final class ReadAloud: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    static let shared = ReadAloud()

    @Published var enabled = UserDefaults.standard.bool(forKey: "assistantReadAloud") {
        didSet {
            UserDefaults.standard.set(enabled, forKey: "assistantReadAloud")
            if !enabled, !talk { cancel() }
        }
    }
    /// Charla: lee la respuesta y vuelve a escuchar. Se prende a propósito cada vez (no se guarda).
    @Published var talk = false
    /// La voz elegida (su `identifier`); sin elegir, la mejor.
    @Published var voiceId = UserDefaults.standard.string(forKey: "assistantVoice") {
        didSet { UserDefaults.standard.set(voiceId, forKey: "assistantVoice") }
    }
    /// La velocidad (1 es la normal de la voz); la próxima lectura sale así.
    @Published var rate = rates.contains(UserDefaults.standard.double(forKey: "assistantRate"))
        ? UserDefaults.standard.double(forKey: "assistantRate") : 1 {
        didSet {
            UserDefaults.standard.set(rate, forKey: "assistantRate")
            resume()
        }
    }
    static let rates: [Double] = [1, 1.25, 1.5]

    /// La siguiente velocidad; después de la última, vuelve a la normal.
    func nextRate() {
        let i = Self.rates.firstIndex(of: rate) ?? -1
        rate = Self.rates[(i + 1) % Self.rates.count]
    }
    /// Qué respuesta se está leyendo ahora.
    @Published private(set) var speaking: UUID?
    /// Las voces en español instaladas, la mejor primero (Premium, después Mejorada).
    let voices: [AVSpeechSynthesisVoice]

    private let synth = AVSpeechSynthesizer()
    private var last: AVSpeechUtterance?
    private var after: (() -> Void)?
    /// Las frases de lo que se está leyendo y cuál suena: al cambiar la velocidad se retoma desde ésa.
    private var parts: [String] = []
    private var queued: [AVSpeechUtterance] = []
    private var at = 0

    override init() {
        voices = Self.spanishVoices()
        super.init()
        synth.delegate = self
    }

    /// Si el pedido lleva `voice`: el runner suma el resumen para el oído.
    var wantsSpeech: Bool { enabled || talk }
    var voice: AVSpeechSynthesisVoice? { voices.first { $0.identifier == voiceId } ?? voices.first }

    static func spanishVoices() -> [AVSpeechSynthesisVoice] {
        // Las de juguete (Eddy, Flo, Grandma… las «Eloquence») son las más robóticas: al final.
        let quality: (AVSpeechSynthesisVoice) -> Int = { voice in
            if voice.identifier.contains(".eloquence.") { return 0 }
            switch voice.quality {
            case .premium: return 3
            case .enhanced: return 2
            default: return 1
            }
        }
        let score = { (v: AVSpeechSynthesisVoice) in quality(v) * 10 + (v.language == language ? 1 : 0) }
        return AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("es") }
            .sorted { score($0) != score($1) ? score($0) > score($1) : $0.name < $1.name }
    }

    /// El español del sistema si está en español; si no, el de España.
    static var language: String {
        let preferred = Locale.preferredLanguages.first ?? ""
        return preferred.lowercased().hasPrefix("es") ? preferred : "es-ES"
    }

    /// Lee `markdown` (lo que se decía se calla); `then` corre al terminar de decirlo todo, no si se cortó.
    func say(_ markdown: String, key: UUID, then: (() -> Void)? = nil) {
        cancel()
        let parts = Speakable.parts(markdown)
        guard !parts.isEmpty else { then?(); return }
        speak(parts, key: key, then: then)
    }

    private func speak(_ parts: [String], key: UUID, then: (() -> Void)?) {
        speaking = key
        after = then
        self.parts = parts
        at = 0
        queued = parts.map { part in
            let utterance = AVSpeechUtterance(string: part)
            utterance.voice = voice
            // La escala de AVSpeech va de 0 a 1 con la normal en 0,5: la velocidad multiplica la normal, sin pasar el tope.
            utterance.rate = min(AVSpeechUtteranceDefaultSpeechRate * Float(rate), AVSpeechUtteranceMaximumSpeechRate)
            return utterance
        }
        queued.forEach(synth.speak)
        last = queued.last
    }

    /// Una frase empezada no cambia de velocidad: lo que se está leyendo sigue, a la nueva, desde el principio de la
    /// frase actual.
    private func resume() {
        guard let key = speaking, at < parts.count else { return }
        let rest = Array(parts[at...])
        let then = after
        cancel()
        speak(rest, key: key, then: then)
    }

    /// Una respuesta que terminó de llegar: se lee si la voz está prendida y, en charla, después se escucha.
    func replied(_ markdown: String, key: UUID, listen: @escaping () -> Void) {
        guard wantsSpeech else { return }
        // Se mira `talk` al terminar de leer, no al empezar: si se apagó mientras leía, no se abre el micrófono.
        say(markdown, key: key) { [weak self] in if self?.talk == true { listen() } }
    }

    func cancel() {
        after = nil
        last = nil
        parts = []
        queued = []
        speaking = nil
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { [self] in
            if let i = queued.firstIndex(where: { $0 === utterance }) { at = i }
        }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { [self] in
            guard utterance === last else { return }
            let then = after
            cancel()
            then?()
        }
    }
}

/// Dicta la pregunta: lo dicho se suma a lo que ya estaba escrito y se ve mientras se reconoce. Terminar con «enviar»
/// (o «listo») la manda; 4 s callado también, si se dijo algo (si no, sólo apaga el micrófono).
final class Dictation: ObservableObject {
    static let shared = Dictation()

    /// Qué chat está dictando (uno a la vez: el micrófono es uno).
    @Published private(set) var owner: ObjectIdentifier?
    @Published private(set) var error: String?

    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var silence: DispatchWorkItem?
    /// Sube con cada `stop`: un `start` que todavía esperaba los permisos y ya no es el último no abre el micrófono
    /// (dos taps sobre el mismo bus tiran la app).
    private var generation = 0

    func isListening(_ chat: AnyObject) -> Bool { owner == ObjectIdentifier(chat) }

    /// `write` recibe la caja completa a medida que se reconoce; `send`, la pregunta que hay que mandar.
    func toggle(for chat: AnyObject, base: String, write: @escaping (String) -> Void, send: @escaping (String) -> Void) {
        if isListening(chat) { return stop() }
        start(for: chat, base: base, write: write, send: send)
    }

    /// Empieza a escuchar para `chat` (lo que se dictaba en otro se corta).
    func start(for chat: AnyObject, base: String, write: @escaping (String) -> Void, send: @escaping (String) -> Void) {
        stop()
        error = nil
        let mine = generation
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                guard mine == self.generation else { return }
                guard status == .authorized else { self.error = "Sin permiso para el reconocimiento de voz (Ajustes › Privacidad)."; return }
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    DispatchQueue.main.async {
                        guard mine == self.generation else { return }
                        guard granted else { self.error = "Sin permiso para usar el micrófono (Ajustes › Privacidad)."; return }
                        self.begin(owner: ObjectIdentifier(chat), base: base, write: write, send: send)
                    }
                }
            }
        }
    }

    private func begin(owner: ObjectIdentifier, base: String, write: @escaping (String) -> Void, send: @escaping (String) -> Void) {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: ReadAloud.language)), recognizer.isAvailable else {
            error = "El dictado no está disponible ahora."
            return
        }
        // La voz que lee no se dicta a sí misma.
        ReadAloud.shared.cancel()
        // Uno a la vez: el micrófono es uno y su bus admite un solo tap.
        stop()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        let input = engine.inputNode
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in request.append(buffer) }
        engine.prepare()
        do { try engine.start() } catch {
            input.removeTap(onBus: 0)
            self.error = "No se pudo abrir el micrófono."
            return
        }
        let head = base.isEmpty || base.last?.isWhitespace == true ? base : base + " "
        self.request = request
        self.owner = owner
        var transcript = Transcript()
        var spoken = ""
        let finish = { [weak self] (text: String) in
            self?.stop()
            write(text)
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { send(text) }
        }
        let quiet = { [weak self] in
            self?.silence?.cancel()
            let item = DispatchWorkItem { [weak self] in
                guard let self, self.owner == owner else { return }
                spoken.isEmpty ? self.stop() : finish((head + spoken).trimmingCharacters(in: .whitespaces))
            }
            self?.silence = item
            DispatchQueue.main.asyncAfter(deadline: .now() + DictationCommand.silence, execute: item)
        }
        task = recognizer.recognitionTask(with: request) { [weak self] result, failure in
            DispatchQueue.main.async {
                // `owner` deja de ser éste al enviar o cortar: lo que llegue tarde no vuelve a la caja.
                guard let self, self.owner == owner else { return }
                if let result {
                    let best = result.bestTranscription
                    spoken = transcript.update(best.formattedString, start: best.segments.first?.timestamp ?? 0)
                    if let command = DictationCommand.withoutSendWord(head + spoken) { return finish(command) }
                    write(head + spoken)
                    quiet()
                }
                if result?.isFinal == true || failure != nil { self.stop() }
            }
        }
        quiet()
    }

    func stop() {
        generation += 1
        silence?.cancel()
        silence = nil
        guard owner != nil else { return }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.finish()
        request = nil
        task = nil
        owner = nil
    }
}
