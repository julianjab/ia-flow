import SwiftUI

// La bandeja: la vista elegida (Para mí · En curso · Próximo) o, con la lupa, lo que coincide. Arriba, lo que hay que
// saber antes (el runner no responde, falta el login). Cargando, un skeleton; caído, lo último que se vio atenuado.

struct InboxScreen: View {
    @ObservedObject var runner: RunnerModel

    var body: some View {
        VStack(spacing: 0) {
            if runner.searchOpen { SearchField(runner: runner).padding(.horizontal, 14).padding(.bottom, 10) }
            FittingScroll {
                VStack(alignment: .leading, spacing: 14) {
                    notices
                    if runner.inbox == nil, runner.error == nil {
                        LoadingSkeleton()
                    } else if runner.inbox != nil {
                        Group {
                            if runner.searchOpen, runner.filtering {
                                SearchResults(runner: runner)
                            } else {
                                switch runner.tab {
                                case .mine: ForMeView(runner: runner)
                                case .running: InProgressView(runner: runner)
                                case .next: NextView(runner: runner)
                                }
                            }
                        }
                        // caído: lo último que se vio queda, atenuado
                        .opacity(runner.error == nil ? 1 : 0.35)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 12)
            }
        }
    }

    @ViewBuilder private var notices: some View {
        if let error = runner.error { RunnerDownCard(runner: runner, error: error) }
        if let login = runner.login { DeviceLoginCard(runner: runner, login: login) }
        else if runner.github == nil, runner.error == nil, runner.inbox != nil, runner.tab == .mine, !runner.searchOpen { loginBanner }
    }

    private var loginBanner: some View {
        Banner(text: "Para aprobar, reintentar o responder, el runner firma con tu login de GitHub.", tone: .info, icon: "person.badge.key.fill") {
            Button("Iniciar sesión con GitHub") { runner.beginLogin() }.buttonStyle(PillButtonStyle(prominent: true, compact: true)).fixedSize()
        }
    }
}

/// «ia-flow.ss.lahaus.com no responde desde hace 2 min. → Puede estar reiniciando.» con Reintentar y Cambiar de runner;
/// si pide su token, cómo dárselo.
struct RunnerDownCard: View {
    @ObservedObject var runner: RunnerModel
    let error: RunnerError

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if error.needsRunnerToken {
                Text("\(runner.selected.name) pide su IA_FLOW_API_TOKEN.").font(.lh(12.5, .semibold))
                Text("→ Agregalo como «token» en la lista de servidores. (\(error.message))").font(.lh(12)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("\(runner.selected.name) no responde\(runner.downFor.map { " desde hace \($0)" } ?? "").").font(.lh(12.5, .semibold))
                Text("→ Puede estar reiniciando. Lo último que se vio queda abajo, atenuado.").font(.lh(12)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(error.message).font(.lh(11)).foregroundStyle(.tertiary).lineLimit(2).textSelection(.enabled)
            }
            HStack(spacing: 6) {
                if error.needsRunnerToken {
                    Button("Editar servidores") { runner.openServersFile() }.buttonStyle(PillButtonStyle(prominent: true, compact: true)).fixedSize()
                } else {
                    Button("Reintentar") { runner.refresh() }.buttonStyle(PillButtonStyle(prominent: true, compact: true)).fixedSize()
                }
                Button("Cambiar de runner") { runner.showRunners() }.buttonStyle(PillButtonStyle(compact: true)).fixedSize()
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.red.opacity(0.12)))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.red.opacity(0.35)))
    }
}

/// Cargando: tres líneas por card, sin texto.
struct LoadingSkeleton: View {
    var body: some View {
        VStack(spacing: 10) {
            ForEach(0..<3, id: \.self) { _ in
                VStack(alignment: .leading, spacing: 7) {
                    bar(0.35, height: 8)
                    bar(0.85, height: 11)
                    bar(0.6, height: 8)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .card()
            }
        }
        .accessibilityLabel("Cargando la bandeja")
    }

    private func bar(_ fraction: CGFloat, height: CGFloat) -> some View {
        GeometryReader { g in
            RoundedRectangle(cornerRadius: 4, style: .continuous).fill(Palette.control).frame(width: g.size.width * fraction)
        }
        .frame(height: height)
    }
}

/// Un grupo con título («Corriendo ahora», «Pueden arrancar 2») y sus filas en una card.
struct InboxSection<Content: View>: View {
    let title: String
    var count: Int? = nil
    var trailing: String? = nil
    var plain = false
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(title).font(.lh(12.5, .semibold)).foregroundStyle(.secondary)
                if let count, count > 0 { Text("\(count)").font(.lh(11.5)).foregroundStyle(.tertiary) }
                Spacer(minLength: 4)
                if let trailing { Text(trailing).font(.lh(11.5)).foregroundStyle(.tertiary).lineLimit(1) }
            }
            if plain {
                content
            } else {
                VStack(alignment: .leading, spacing: 0) { content }.card()
            }
        }
    }
}

// MARK: buscar (⌘K)

/// Lo que coincide con la lupa: «En la bandeja» (todas las vistas), «En el resto del board» y, al pie, GitHub.
struct SearchResults: View {
    @ObservedObject var runner: RunnerModel

    var body: some View {
        let decisions = runner.shownDecisions, running = runner.shownRunning, queued = runner.shownQueued
        let feed = runner.shownFeed, epics = runner.shownEpics
        let inbox = decisions.count + running.count + queued.count + feed.ready.count + feed.waiting.count
        VStack(alignment: .leading, spacing: 14) {
            if inbox > 0 {
                InboxSection(title: "En la bandeja", count: inbox) {
                    let tasks = decisions + running + queued
                    ForEach(Array(tasks.enumerated()), id: \.element.ref) { i, item in
                        if i > 0 { Divider().opacity(0.4).padding(.vertical, 4) }
                        TaskRow(runner: runner, item: item)
                    }
                    ForEach(Array((feed.ready + feed.waiting).enumerated()), id: \.element.ref) { i, item in
                        if i > 0 || !tasks.isEmpty { Divider().opacity(0.4).padding(.vertical, 6) }
                        FeedRow(runner: runner, item: item)
                    }
                }
            }
            if !epics.isEmpty {
                InboxSection(title: "Épicas", count: epics.count) {
                    ForEach(Array(epics.enumerated()), id: \.element.id) { i, epic in
                        if i > 0 { Divider().opacity(0.4).padding(.vertical, 8) }
                        EpicRow(runner: runner, epic: epic)
                    }
                }
            }
            if !runner.shownImprovements.isEmpty {
                DashedLink(text: "\(runner.shownImprovements.count) mejoras coinciden", action: "Ver") { runner.showImprovements() }
            }
            boardSection
            if runner.resultCount == 0, !runner.searching { noResults }
            if runner.search != nil { githubHandoff }
        }
    }

    /// Lo que coincide fuera de la bandeja: las primeras con sus acciones, el resto como fila corta.
    @ViewBuilder
    private var boardSection: some View {
        let detailed = Set(runner.lookups.map(\.ref))
        let rest = runner.boardResults.filter { !detailed.contains($0.ref) }
        if !runner.lookups.isEmpty || !rest.isEmpty {
            InboxSection(title: "En el resto del board", count: runner.lookups.count + rest.count) {
                ForEach(Array(runner.lookups.enumerated()), id: \.element.ref) { i, item in
                    if i > 0 { Divider().opacity(0.4).padding(.vertical, 6) }
                    TaskRow(runner: runner, item: item)
                }
                ForEach(Array(rest.prefix(20).enumerated()), id: \.element.ref) { i, item in
                    if i > 0 || !runner.lookups.isEmpty { Divider().opacity(0.4).padding(.vertical, 6) }
                    BoardRow(runner: runner, item: item)
                }
            }
        }
        if let miss = runner.lookupMiss {
            Banner(text: "\(miss) no está en ningún board de este runner.", tone: .neutral, icon: "magnifyingglass") {
                Button("Abrir en GitHub") { runner.openTask(miss) }.buttonStyle(PillButtonStyle(compact: true)).fixedSize()
            }
        }
    }

    /// Lo que no es del runner se busca aparte: la pantalla «GitHub», con lo escrito y el repo del tag.
    private var githubHandoff: some View {
        DashedLink(text: "Buscar «\(runner.query)» en GitHub", action: "Buscar") {
            runner.showGithub(query: runner.query, repo: runner.repoFilter)
        }
        .help("Buscar en cualquier repo de la organización (no sólo los del board)")
    }

    private var noResults: some View {
        Text(runner.search == nil
             ? "Nada de \(runner.repoFilter ?? "") en la bandeja."
             : "Nada coincide con «\(runner.query)»\(runner.repoFilter.map { " en \($0)" } ?? "") en la bandeja ni en el board.")
            .font(.lh(12)).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).card()
    }
}
