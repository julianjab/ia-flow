import SwiftUI

// Las filas que mueven cards en el board: una card de Todo («Por arrancar», con «Mover a ▸») y el menú «Agregar al
// board ▸» de un resultado de «Buscar en GitHub». Sólo dibujan; lo que hacen está en Feed.swift.

/// Una card de Todo: el título (abre el issue), a quién espera si espera, su repo y «Mover a ▸» con las columnas.
struct FeedRow: View {
    @ObservedObject var runner: RunnerModel
    let item: FeedItem

    var body: some View {
        let busy = runner.busy.contains(item.ref)
        HStack(spacing: 6) {
            Button { runner.open(item) } label: {
                HStack(spacing: 6) {
                    Text(item.displayTitle).font(.lh(12)).lineLimit(1)
                    Spacer(minLength: 4)
                    let waiting = item.waitingFor
                    if !waiting.isEmpty {
                        Text("espera \(waiting.joined(separator: ", "))").font(.lh(11)).foregroundStyle(Color.orange).lineLimit(1).fixedSize()
                    }
                    refTag(item.ref)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(help)
            if busy {
                ProgressView().controlSize(.small).scaleEffect(0.5).frame(width: 24, height: 20)
            } else {
                Menu {
                    moveMenu
                    Divider()
                    Button("Abrir issue en GitHub") { runner.open(item) }
                    ForEach(item.blocked_by ?? [], id: \.self) { blocker in
                        Button("Abrir \(blocker)") { runner.openTask(blocker) }
                    }
                } label: {
                    Image(systemName: "ellipsis").font(.system(size: 12, weight: .semibold)).frame(width: 24, height: 20).contentShape(Rectangle())
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().foregroundStyle(.secondary)
                .help("Mover a otra columna")
            }
        }
    }

    @ViewBuilder private var moveMenu: some View {
        let columns = runner.destinations(item)
        if columns.isEmpty {
            Text("Este runner no informa las columnas del board")
        } else {
            Menu("Mover a") {
                ForEach(columns, id: \.self) { status in Button(status) { runner.move(item, to: status) } }
            }
        }
    }

    private var help: String {
        let waiting = (item.blocked_by ?? []).joined(separator: ", ")
        return waiting.isEmpty ? "\(item.title)\nPuede arrancar" : "\(item.title)\nEspera a \(waiting)"
    }
}

/// «Agregar al board ▸»: las columnas (Todo por defecto); con más de un proyecto en el runner, primero el proyecto.
struct BoardAddMenu: View {
    @ObservedObject var runner: RunnerModel
    @ObservedObject var model: GithubSearchModel
    let issue: GithubIssue

    var body: some View {
        if runner.busy.contains(issue.ref) {
            ProgressView().controlSize(.small).scaleEffect(0.5).frame(width: 24, height: 20)
        } else {
            Menu {
                if runner.projects.count > 1 {
                    Menu("Agregar al board") {
                        ForEach(runner.projects, id: \.id) { project in
                            Menu(project.id) { columns(project.id) }
                        }
                    }
                } else {
                    Menu("Agregar al board") { columns(runner.projects.first?.id) }
                }
                Divider()
                Button("Abrir en GitHub") { runner.openTask(issue.ref) }
            } label: {
                Image(systemName: "plus.rectangle.on.rectangle").font(.system(size: 11, weight: .semibold))
                    .frame(width: 24, height: 20).contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().foregroundStyle(.secondary)
            .help("Agregar al board del runner")
        }
    }

    /// Todo (sin `status`: el runner sabe cuál es su columna de entrada) y después el resto de las columnas.
    @ViewBuilder private func columns(_ project: String?) -> some View {
        Button("Todo (por defecto)") { model.add(issue, project: project, status: nil) }
        let others = runner.statuses(project: project).filter { $0.caseInsensitiveCompare("Todo") != .orderedSame }
        if !others.isEmpty {
            Divider()
            ForEach(others, id: \.self) { status in Button(status) { model.add(issue, project: project, status: status) } }
        }
    }
}
