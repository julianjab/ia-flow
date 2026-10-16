import SwiftUI

// La pantalla «GitHub» de la pestaña Runner: buscar en cualquier repo de la organización (el selector de repo es una
// lista filtrable: son cientos), y la fila de un resultado. Sólo dibuja GithubSearchModel.

struct GithubSearchScreen: View {
    @ObservedObject var runner: RunnerModel
    @ObservedObject var model: GithubSearchModel
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                IconButton(symbol: "chevron.left", help: "Volver") { runner.screen = .inbox }
                VStack(alignment: .leading, spacing: 1) {
                    Text("Buscar en GitHub").font(.lh(17, .bold))
                    Text("Cualquier repo de \(model.org)").font(.lh(12)).foregroundStyle(.secondary)
                }
                Spacer()
                if model.searching || model.loadingRepos { ProgressView().controlSize(.small).scaleEffect(0.6) }
            }
            .padding(.horizontal, 14).padding(.top, 14).padding(.bottom, 10)

            HStack(spacing: 8) {
                repoButton
                FieldBox {
                    TextField(model.placeholder, text: $model.query)
                        .focused($focused)
                        .onSubmit { focused = true }
                }
                if !model.query.isEmpty {
                    Button { model.query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary) }
                        .buttonStyle(.plain).help("Borrar")
                }
            }
            .padding(.horizontal, 14).padding(.bottom, 10)

            FittingScroll {
                VStack(alignment: .leading, spacing: 10) {
                    if model.pickingRepo { repoPicker }
                    if let login = runner.login { DeviceLoginCard(runner: runner, login: login) }
                    else if model.needsLogin || (runner.github == nil && !runner.isFixture) { loginBanner }
                    results
                }
                .padding(.horizontal, 14).padding(.bottom, 12)
            }
        }
        .onAppear {
            model.appear()
            focused = true
        }
    }

    // MARK: el repo

    private var repoButton: some View {
        Button { model.pickingRepo.toggle() } label: {
            if let repo = model.repo {
                RepoTag(repo: repo, chevron: true)
            } else {
                HStack(spacing: 3) {
                    Text("Toda \(model.org)").font(.lh(10.5, .semibold)).lineLimit(1)
                    Image(systemName: "chevron.down").font(.system(size: 7.5, weight: .bold)).opacity(0.7)
                }
                .padding(.horizontal, 7).padding(.vertical, 2.5)
                .foregroundStyle(.secondary)
                .background(Capsule().fill(Color.primary.opacity(0.08)))
                .fixedSize()
            }
        }
        .buttonStyle(.plain)
        .help("Elegir el repo donde buscar")
    }

    /// La lista de repos, filtrable: los del board primero, después el resto por actividad.
    private var repoPicker: some View {
        let shown = model.shownRepos
        return VStack(alignment: .leading, spacing: 6) {
            FieldBox {
                TextField("Filtrar \(model.repos.isEmpty ? "repos" : "\(model.repos.count) repos")…", text: $model.repoFilter)
                    .onSubmit { if let first = shown.board.first ?? shown.others.first { model.select(first) } }
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    repoRow(nil, title: "Toda \(model.org)")
                    if !shown.board.isEmpty {
                        SectionTitle(text: "En el board").padding(.top, 6).padding(.horizontal, 6)
                        ForEach(shown.board, id: \.self) { repoRow($0, title: $0) }
                    }
                    if !shown.others.isEmpty {
                        SectionTitle(text: "Todos, por actividad", trailing: "\(shown.others.count)").padding(.top, 6).padding(.horizontal, 6)
                        ForEach(shown.others, id: \.self) { repoRow($0, title: $0) }
                    } else if model.loadingRepos {
                        Text("Cargando los repos de \(model.org)…").font(.lh(11.5)).foregroundStyle(.tertiary).padding(6)
                    }
                }
            }
            .frame(maxHeight: 240)
        }
        .card()
    }

    private func repoRow(_ name: String?, title: String) -> some View {
        Button { model.select(name) } label: {
            HStack(spacing: 6) {
                if let name { Circle().fill(RepoTag.color(name)).frame(width: 7, height: 7) }
                else { Image(systemName: "building.2").font(.system(size: 10)).foregroundStyle(.secondary) }
                Text(title).font(.lh(12)).lineLimit(1)
                Spacer()
                if model.repo == name { Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(Color.accentColor) }
            }
            .padding(.horizontal, 6).padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: resultados

    @ViewBuilder private var results: some View {
        if !model.results.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(model.results.enumerated()), id: \.element.ref) { i, issue in
                    if i > 0 { Divider().opacity(0.4).padding(.vertical, 6) }
                    GithubRow(runner: runner, model: model, issue: issue)
                }
            }
            .card()
        }
        if let note = model.note {
            Label(note, systemImage: "magnifyingglass").font(.lh(12)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else if model.query.isEmpty, !model.pickingRepo {
            Text(model.repo == nil
                 ? "Texto del título en toda \(model.org), `repo#1881`, o el link de un issue o PR. Para buscar por número, elige un repo."
                 : "El número de un issue o PR de \(model.repo!), o texto del título.")
                .font(.lh(12)).foregroundStyle(.tertiary).fixedSize(horizontal: false, vertical: true)
        }
    }

    private var loginBanner: some View {
        Banner(text: "La búsqueda en GitHub usa tu login (sólo lectura).", tone: .info, icon: "person.badge.key.fill") {
            Button("Iniciar sesión con GitHub") { runner.beginLogin() }.buttonStyle(PillButtonStyle(prominent: true, compact: true)).fixedSize()
        }
    }
}

/// Un issue o PR de GitHub: abierto o cerrado, el título y su repo; clic lo abre en el navegador. Si ya está en el
/// board, su columna; un issue abierto que no está lleva «Agregar al board ▸» (un PR no entra al board).
struct GithubRow: View {
    @ObservedObject var runner: RunnerModel
    @ObservedObject var model: GithubSearchModel
    let issue: GithubIssue
    @Environment(\.openURL) private var openURL

    var body: some View {
        HStack(spacing: 4) {
            link
            if let status = model.boardStatus(issue) {
                Chip(text: status.isEmpty ? "en el board" : status, tone: .info).fixedSize().help("Ya está en el board del runner")
            } else if !issue.isPR, issue.open {
                BoardAddMenu(runner: runner, model: model, issue: issue)
            }
        }
    }

    private var link: some View {
        Button { if let url = URL(string: issue.url) { openURL(url) } } label: {
            HStack(spacing: 6) {
                Image(systemName: issue.isPR ? "arrow.triangle.pull" : issue.open ? "circle.circle" : "checkmark.circle")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(issue.open ? Color.green : Color.purple)
                    .help(issue.open ? "Abierto" : "Cerrado")
                Text(issue.title).font(.lh(12)).lineLimit(1)
                Spacer(minLength: 4)
                if let when = ago(issue.updatedAt) { Text(when).font(.lh(10.5)).foregroundStyle(.tertiary).fixedSize() }
                refTag(issue.ref)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("\(issue.title)\nAbrir en GitHub")
    }
}
