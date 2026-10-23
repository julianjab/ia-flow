import SwiftUI

// «Próximo» — nada queda afuera: las épicas con su avance; TODAS las cards de Todo («Pueden arrancar» y «Esperan a
// otra»: 8 a la vista y «Ver las N» despliega el resto en el lugar); el resto del board, columna por columna y con
// todas sus cards; los issues abiertos de los repos del runner que no tienen card («En los repos, sin card», por
// repo); y agregar un issue al board.

struct NextView: View {
    @ObservedObject var runner: RunnerModel

    private static let limit = 8

    var body: some View {
        let epics = runner.epics.filter { epic in runner.nextProject.map { p in epic.items.contains { $0.project_id == p } } ?? true }
        let feed = runner.nextFeed
        VStack(alignment: .leading, spacing: 14) {
            topBar
            if !epics.isEmpty {
                let stuck = epics.filter { $0.items.contains(where: \.isDecision) }.count
                InboxSection(title: "Épicas", count: epics.count, trailing: stuck == 0 ? nil : stuck == 1 ? "1 trabada en vos" : "\(stuck) trabadas en vos") {
                    ForEach(Array(epics.enumerated()), id: \.element.id) { i, epic in
                        if i > 0 { Divider().opacity(0.4).padding(.vertical, 9) }
                        EpicCard(runner: runner, epic: epic)
                    }
                }
            }
            if !feed.ready.isEmpty {
                InboxSection(title: "Pueden arrancar", count: feed.ready.count) { list(feed.ready, key: "ready") }
            }
            if !feed.waiting.isEmpty {
                InboxSection(title: "Esperan a otra", count: feed.waiting.count) { list(feed.waiting, key: "waiting") }
            }
            if epics.isEmpty, feed.ready.isEmpty, feed.waiting.isEmpty {
                Text("No hay nada por arrancar.").font(.lh(12)).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).card()
            }
            boardRest
            RepoIssuesSection(runner: runner)
            AddIssueForm(runner: runner)
        }
    }

    /// El proyecto (sólo con más de uno) y el board en GitHub.
    @ViewBuilder private var topBar: some View {
        let projects = runner.projects
        if projects.count > 1 || runner.boardURL != nil {
            HStack(spacing: 8) {
                if projects.count > 1 {
                    Menu {
                        Button("Todos los proyectos") { runner.nextProject = nil }
                        Divider()
                        ForEach(projects, id: \.id) { project in Button(project.id) { runner.nextProject = project.id } }
                    } label: {
                        HStack(spacing: 4) {
                            Text(runner.nextProject ?? "Todos los proyectos").font(.lh(12, .semibold))
                            Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold))
                        }
                        .padding(.horizontal, 9).padding(.vertical, 4)
                        .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Palette.control))
                    }
                    .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
                }
                Spacer()
                if runner.boardURL != nil {
                    Button("Board ↗") { runner.openBoard() }.buttonStyle(.plain).font(.lh(12, .semibold)).foregroundStyle(Palette.link)
                        .help("Abrir el board en GitHub")
                }
            }
        }
    }

    /// Las primeras 8 y «Ver las N» (despliega en el lugar, sin navegar). Buscando, todas.
    @ViewBuilder private func list(_ items: [FeedItem], key: String) -> some View {
        let open = runner.expanded.contains(key) || runner.filtering
        let shown = open ? items : Array(items.prefix(Self.limit))
        ForEach(Array(shown.enumerated()), id: \.element.ref) { i, item in
            if i > 0 { Divider().opacity(0.4).padding(.vertical, 6) }
            FeedRow(runner: runner, item: item)
        }
        if items.count > Self.limit, !runner.filtering {
            Button(open ? "Ver menos" : "Ver las \(items.count)") {
                withAnimation(.easeOut(duration: 0.15)) {
                    if open { runner.expanded.remove(key) } else { runner.expanded.insert(key) }
                }
            }
            .buttonStyle(.plain).font(.lh(12, .semibold)).foregroundStyle(Palette.link).padding(.top, 8)
        }
    }

    /// «Resto del board»: una fila plegada por columna con su conteo; abierta, todas sus cards.
    @ViewBuilder private var boardRest: some View {
        let columns = runner.nextBoard.filter { !$0.items.isEmpty }
        if !columns.isEmpty {
            InboxSection(title: "Resto del board", trailing: "sin nada pendiente") {
                ForEach(Array(columns.enumerated()), id: \.element.id) { i, column in
                    if i > 0 { Divider().opacity(0.4).padding(.vertical, 5) }
                    let key = "column:\(column.status)"
                    let open = runner.expanded.contains(key)
                    Button {
                        withAnimation(.easeOut(duration: 0.15)) { if open { runner.expanded.remove(key) } else { runner.expanded.insert(key) } }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "chevron.right").font(.system(size: 8.5, weight: .bold)).foregroundStyle(.tertiary)
                                .rotationEffect(.degrees(open ? 90 : 0))
                            Text(column.status).font(.lh(12.5, .semibold))
                            Spacer()
                            Text("\(column.items.count)").font(.lh(12)).foregroundStyle(.secondary).monospacedDigit()
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if open {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(column.items) { item in BoardRow(runner: runner, item: item) }
                        }
                        .padding(.leading, 14).padding(.top, 6)
                    }
                }
            }
        }
    }
}

/// Una épica: el título y «19/24», la barra, «Sigue #n · …», «2 te esperan · 2 corriendo» y «Ver épica».
struct EpicCard: View {
    @ObservedObject var runner: RunnerModel
    let epic: EpicView

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(epic.epic.displayTitle).font(.lh(13, .semibold)).lineLimit(2).multilineTextAlignment(.leading)
                Spacer(minLength: 6)
                Text("\(epic.epic.done)/\(epic.epic.total)").font(.lh(11.5, .semibold)).foregroundStyle(.secondary).monospacedDigit()
            }
            ProgressBar(value: epic.progress)
            if let next = epic.next {
                Button { runner.showTask(next) } label: {
                    (Text(next.isDecision ? "Sigue " : next.group == "run" ? "Corre " : "Espera ").foregroundColor(next.isDecision ? Palette.amber : .secondary).bold()
                     + Text("\(next.shortRef) · ").font(.mono(11)).foregroundColor(.secondary)
                     + Text(next.displayTitle).foregroundColor(.primary.opacity(0.8)))
                        .font(.lh(11.5)).lineLimit(1)
                }
                .buttonStyle(.plain)
                .help("Ver \(next.ref)")
            }
            HStack {
                Text(summary).font(.lh(11.5)).foregroundStyle(.tertiary)
                Spacer()
                Button("Ver épica") { runner.showEpic(epic.epic.ref) }.buttonStyle(PillButtonStyle(compact: true)).fixedSize()
            }
        }
    }

    private var summary: String {
        let decisions = epic.items.filter(\.isDecision).count
        var parts: [String] = []
        if decisions > 0 { parts.append("\(decisions) te \(decisions == 1 ? "espera" : "esperan")") }
        if epic.running > 0 { parts.append("\(epic.running) corriendo") }
        let rest = epic.items.count - decisions - epic.running
        if rest > 0 { parts.append("\(rest) en cola") }
        return parts.isEmpty ? "nada corriendo" : parts.joined(separator: " · ")
    }
}

// MARK: en los repos, sin card

/// Los issues abiertos de los repos del runner que no están en ningún board: por repo, con «Agregar al board ▾». Un
/// repo que no se pudo leer dice por qué en una línea; uno cortado lleva «Hay más en GitHub ↗». Sin el endpoint en el
/// runner (404), no se dibuja.
struct RepoIssuesSection: View {
    @ObservedObject var runner: RunnerModel

    var body: some View {
        if let data = runner.repoIssues {
            let repos = data.repos.filter { repo in
                (runner.nextProject.map { repo.project_id == nil || repo.project_id == $0 } ?? true)
                    && (runner.repoFilter.map { repo.repo.hasSuffix("/\($0)") } ?? true)
            }
            let total = repos.reduce(0) { $0 + $1.items.count }
            if !repos.isEmpty {
                InboxSection(title: "En los repos, sin card", count: total) {
                    ForEach(Array(repos.enumerated()), id: \.element.id) { i, repo in
                        if i > 0 { Divider().opacity(0.4).padding(.vertical, 8) }
                        group(repo)
                    }
                }
            }
        }
    }

    @ViewBuilder private func group(_ repo: RepoIssues.Repo) -> some View {
        let name = repo.repo.split(separator: "/").last.map(String.init) ?? repo.repo
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                RepoTag(repo: name)
                Text("\(repo.items.count)").font(.lh(11.5)).foregroundStyle(.tertiary)
                Spacer()
            }
            if let error = repo.error {
                Text("No se pudo leer: \(error)").font(.lh(11.5)).foregroundStyle(Palette.red).lineLimit(1).help(error)
            }
            let key = "repo:\(repo.repo)"
            let open = runner.expanded.contains(key)
            let shown = open ? repo.items : Array(repo.items.prefix(5))
            ForEach(shown) { issue in RepoIssueRow(runner: runner, issue: issue, project: repo.project_id) }
            HStack(spacing: 12) {
                if repo.items.count > 5 {
                    Button(open ? "Ver menos" : "Ver los \(repo.items.count)") {
                        if open { runner.expanded.remove(key) } else { runner.expanded.insert(key) }
                    }
                    .buttonStyle(.plain).font(.lh(12, .semibold)).foregroundStyle(Palette.link)
                }
                if repo.truncated == true {
                    Button("Hay más en GitHub ↗") {
                        if let url = URL(string: "https://github.com/\(repo.repo)/issues?q=is%3Aissue+is%3Aopen") { NSWorkspace.shared.open(url) }
                    }
                    .buttonStyle(.plain).font(.lh(12)).foregroundStyle(Palette.link)
                }
            }
        }
    }
}

/// Un issue sin card: la ref en mono, el título, hace cuánto y quién lo abrió, y «Agregar al board ▾».
struct RepoIssueRow: View {
    @ObservedObject var runner: RunnerModel
    let issue: RepoIssue
    let project: String?

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            Button { _ = URL(string: issue.url).map { NSWorkspace.shared.open($0) } } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(issue.title).font(.lh(12.5)).lineLimit(2).multilineTextAlignment(.leading)
                    Text([shortRef(issue.ref), issue.updated_at.flatMap { ago($0) }.map { $0 == "ahora" ? $0 : "hace \($0)" },
                          issue.author.map { "@\($0)" }].compactMap { $0 }.joined(separator: " · "))
                        .font(.mono(10.5)).foregroundStyle(.secondary).lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Abrir \(issue.ref) en GitHub")
            AddToBoardButton(runner: runner, ref: issue.ref, project: issue.project_id ?? project)
        }
    }
}

/// «Agregar al board ▾»: Todo por defecto o cualquier otra columna del proyecto.
struct AddToBoardButton: View {
    @ObservedObject var runner: RunnerModel
    let ref: String
    let project: String?

    var body: some View {
        if runner.busy.contains(ref) {
            ProgressView().controlSize(.small).scaleEffect(0.5).frame(width: 30, height: 20)
        } else {
            Menu {
                Button("Todo (por defecto)") { runner.addToBoard(ref: ref, project: project, status: nil) }
                let others = runner.statuses(project: project).filter { $0.caseInsensitiveCompare("Todo") != .orderedSame }
                if !others.isEmpty {
                    Divider()
                    ForEach(others, id: \.self) { status in Button(status) { runner.addToBoard(ref: ref, project: project, status: status) } }
                }
            } label: {
                Text("Agregar al board ▾").font(.lh(11.5, .semibold))
                    .padding(.horizontal, 9).padding(.vertical, 4)
                    .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Palette.control))
            }
            .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
            .help("Agregar al board del runner con tu login")
        }
    }
}

// MARK: agregar un issue al board

/// «Agregar un issue al board»: el issue (`owner/repo#n` o link), el proyecto (con más de uno) y la columna (Todo por
/// defecto). El error dice qué hacer.
struct AddIssueForm: View {
    @ObservedObject var runner: RunnerModel
    @State private var open = false
    @State private var text = ""
    @State private var project: String?
    @State private var status: String?
    @State private var outcome: AddToBoardResult?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !open {
                DashedLink(text: "Agregar un issue al board", action: "owner/repo#n o link") { open = true }
            } else {
                HStack {
                    Text("Agregar un issue al board").font(.lh(12.5, .semibold))
                    Spacer()
                    Button { open = false; outcome = nil } label: { Image(systemName: "xmark").font(.system(size: 9, weight: .bold)) }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                }
                FieldBox(invalid: outcome?.ok == false) {
                    TextField("owner/repo#n o link del issue", text: $text).onSubmit(add)
                }
                HStack(spacing: 8) {
                    if runner.projects.count > 1 {
                        Picker("Proyecto", selection: Binding(get: { project ?? runner.projects.first?.id ?? "" }, set: { project = $0 })) {
                            ForEach(runner.projects, id: \.id) { Text($0.id).tag($0.id) }
                        }
                        .labelsHidden().fixedSize()
                    }
                    Picker("Columna", selection: Binding(get: { status ?? "" }, set: { status = $0.isEmpty ? nil : $0 })) {
                        Text("Todo (por defecto)").tag("")
                        ForEach(runner.statuses(project: project).filter { $0.caseInsensitiveCompare("Todo") != .orderedSame }, id: \.self) {
                            Text($0).tag($0)
                        }
                    }
                    .labelsHidden().fixedSize()
                    Spacer()
                    Button("Agregar al board", action: add).buttonStyle(PillButtonStyle(prominent: true, compact: true)).fixedSize()
                        .disabled(ref == nil || runner.busy.contains(ref ?? ""))
                }
                if let outcome {
                    if outcome.ok {
                        Text("✓ \(outcome.ref.map(refLabel) ?? "") en \(outcome.status ?? status ?? "Todo")").font(.lh(12)).foregroundStyle(Palette.green)
                    } else {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(outcome.message).font(.lh(12, .semibold)).foregroundStyle(Palette.red).fixedSize(horizontal: false, vertical: true)
                            Text("→ \(hint(outcome.message))").font(.lh(12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
    }

    /// `owner/repo#n` del texto (también el link); `repo#n` con el owner de la organización del runner.
    private var ref: String? {
        guard let search = RunnerSearch(text), let number = search.number else { return nil }
        if let full = search.fullRef { return full }
        guard let repo = search.repo, let owner = runner.organization else { return nil }
        return "\(owner)/\(repo)#\(number)"
    }

    private func add() {
        guard let ref else { return }
        outcome = nil
        runner.addToBoard(ref: ref, project: project ?? runner.projects.first?.id, status: status) { result in
            outcome = result
            if result.ok { text = "" }
        }
    }

    private func hint(_ message: String) -> String {
        let m = message.lowercased()
        if m.contains("ya est") || m.contains("409") { return "Movela desde su card en vez de agregarla." }
        if m.contains("repo") { return "El repo tiene que estar en el catálogo del proyecto (projects[].repos)." }
        return "Revisá la ref (owner/repo#n) y que tu login vea el repo."
    }
}
