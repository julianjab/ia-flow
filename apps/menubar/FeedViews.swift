import SwiftUI

// Las filas que mueven cards en el board: una card de Todo (Próximo, con «Mover a ▾») y el menú «Agregar al board ▸»
// de un resultado de «Buscar en GitHub». Sólo dibujan; lo que hacen está en Feed.swift.

/// Una card de Todo: «subscriptions #4320 · Todo» (o «· espera #4281»), el título (abre el issue) y «Mover a ▾» con las
/// columnas de su proyecto (la actual deshabilitada; sale con tu login, sin confirmar). Clic derecho: el resto.
struct FeedRow: View {
    @ObservedObject var runner: RunnerModel
    let item: FeedItem

    var body: some View {
        let busy = runner.busy.contains(item.ref)
        let waiting = item.waitingFor
        HStack(alignment: .center, spacing: 8) {
            Button { runner.open(item) } label: {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Text(refLabel(item.ref)).font(.mono(10.5)).foregroundStyle(.secondary).lineLimit(1)
                        if !waiting.isEmpty {
                            Text("· espera \(waiting.joined(separator: ", "))").font(.lh(11)).foregroundStyle(Palette.amber).lineLimit(1)
                        } else if let status = item.status {
                            Text("· \(status)").font(.lh(11)).foregroundStyle(.tertiary)
                        }
                    }
                    Text(item.displayTitle).font(.lh(12.5)).lineLimit(2).multilineTextAlignment(.leading)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(help)
            if busy {
                ProgressView().controlSize(.small).scaleEffect(0.5).frame(width: 30, height: 20)
            } else if waiting.isEmpty {
                Menu { moveMenu } label: {
                    Text("Mover a ▾").font(.lh(11.5, .semibold))
                        .padding(.horizontal, 9).padding(.vertical, 4)
                        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Palette.control))
                }
                .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
                .help("Mover a otra columna (con tu login, sin confirmar)")
            } else {
                Menu { moveMenu; Divider(); others } label: {
                    Image(systemName: "ellipsis").font(.system(size: 12, weight: .semibold)).frame(width: 26, height: 20).contentShape(Rectangle())
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().foregroundStyle(.secondary)
            }
        }
        .contextMenu { moveMenu; Divider(); others }
    }

    /// Las columnas del proyecto, la actual deshabilitada, y la aclaración.
    @ViewBuilder private var moveMenu: some View {
        let columns = runner.statuses(project: item.project_id)
        if columns.isEmpty {
            Text("Este runner no informa las columnas del board")
        } else {
            ForEach(columns, id: \.self) { status in
                let current = status.caseInsensitiveCompare(item.status ?? "") == .orderedSame
                Button(current ? "\(status) · actual" : status) { runner.move(item, to: status) }.disabled(current)
            }
            Divider()
            Text("Se mueve con tu login, sin confirmar.")
        }
    }

    @ViewBuilder private var others: some View {
        Button("Abrir el issue en GitHub ↗") { runner.open(item) }
        ForEach(item.blocked_by ?? [], id: \.self) { blocker in
            Button("Ver \(shortRef(blocker)), que la bloquea") { runner.goTo(blocker) }
        }
        Button("Abrir worktree del issue en iTerm") { runner.openWorktree(ref: item.ref, pr: nil) }
        Button("Copiar \(item.ref.split(separator: "/").last.map(String.init) ?? item.ref)") {
            runner.copy(item.ref.split(separator: "/").last.map(String.init) ?? item.ref)
        }
    }

    private var help: String {
        let waiting = (item.blocked_by ?? []).joined(separator: ", ")
        return waiting.isEmpty ? "\(item.title)\nPuede arrancar · clic: abrir el issue" : "\(item.title)\nEspera a \(waiting)"
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
