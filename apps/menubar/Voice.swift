import AVFoundation
import Speech
import SwiftUI

// La voz de los chats del asistente (la pestaña y «¿Por qué?» de una mejora): leer las respuestas en voz alta mientras
// llegan (AVSpeechSynthesizer) y dictar la pregunta (Speech, en el equipo si el idioma lo permite). Una sola voz y un
// solo micrófono para toda la app: hablar en un chat calla al otro. Es el mismo recorte que la web
// (`apps/web/src/features/assistant/voice/speakable.ts`): frases completas, sin código ni tablas.

enum Speakable {
    private static let fence = "```"
    private static let sentenceEnd: Set<Character> = [".", "!", "?", "…", ":"]

    /// Cuántos caracteres de `buffer` se pueden leer sin cortar una frase ni entrar a un bloque de código abierto.
    static func readyPrefix(_ buffer: String, final: Bool) -> Int {
        let chars = Array(buffer)
        if final { return chars.count }
        var cut = 0, inFence = false, i = 0
        while i < chars.count {
            if i + 2 < chars.count, chars[i] == "`", chars[i + 1] == "`", chars[i + 2] == "`" {
                inFence.toggle()
                i += 3
                if !inFence { cut = i }
                continue
            }
            if !inFence {
                let c = chars[i]
                let next = i + 1 < chars.count ? chars[i + 1] : nil
                if c == "\n" || (sentenceEnd.contains(c) && next?.isWhitespace == true) { cut = i + 1 }
            }
            i += 1
        }
        return cut
    }

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

/// Lee en voz alta la respuesta que está llegando, frase por frase. Sólo la que se vio nacer: retomar una conversación
/// no la lee entera.
final class ReadAloud: ObservableObject {
    static let shared = ReadAloud()

    @Published var enabled = UserDefaults.standard.bool(forKey: "assistantReadAloud") {
        didSet {
            UserDefaults.standard.set(enabled, forKey: "assistantReadAloud")
            if !enabled { cancel() }
        }
    }

    private let synth = AVSpeechSynthesizer()
    /// La respuesta que se está leyendo y cuántos caracteres de su texto ya se mandaron a la voz.
    private var reading: (id: UUID, spoken: Int)?

    /// El texto completo de la respuesta `id` hasta ahora; con `final`, lo que queda se lee entero.
    func feed(_ id: UUID, text: String, final: Bool) {
        guard enabled else { return }
        if reading?.id != id {
            guard !final else { return }
            cancel()
            reading = (id, 0)
        }
        guard let spoken = reading?.spoken else { return }
        let pending = String(text.dropFirst(spoken))
        let cut = Speakable.readyPrefix(pending, final: final)
        if cut > 0 {
            let say = Speakable.text(String(pending.prefix(cut)))
            if !say.isEmpty { speak(say) }
            reading?.spoken = spoken + cut
        }
        if final { reading = nil }
    }

    func cancel() {
        reading = nil
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
    }

    private func speak(_ text: String) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: Self.language)
        synth.speak(utterance)
    }

    /// El español del sistema si está en español; si no, el de España.
    static var language: String {
        let preferred = Locale.preferredLanguages.first ?? ""
        return preferred.lowercased().hasPrefix("es") ? preferred : "es-ES"
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

    func isListening(_ chat: AnyObject) -> Bool { owner == ObjectIdentifier(chat) }

    /// `write` recibe la caja completa a medida que se reconoce; `send`, la pregunta que hay que mandar.
    func toggle(for chat: AnyObject, base: String, write: @escaping (String) -> Void, send: @escaping (String) -> Void) {
        if isListening(chat) { return stop() }
        stop()
        error = nil
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                guard status == .authorized else { self.error = "Sin permiso para el reconocimiento de voz (Ajustes › Privacidad)."; return }
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    DispatchQueue.main.async {
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
                    spoken = result.bestTranscription.formattedString
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
