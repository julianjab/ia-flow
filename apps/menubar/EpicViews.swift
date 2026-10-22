import SwiftUI

// La pantalla de una épica en la pestaña Runner: su avance y TODOS sus sub-issues (`/api/tasks/…/epic`), con la
// columna de los que son cards del board. Se abre desde el chip de épica de una tarea o desde «Épicas». Un hijo del
// board abre su traza (y «Volver» vuelve acá); uno fuera del board o cerrado, su issue en GitHub.

struct EpicScreen: View {
    @ObservedObject var runner: RunnerModel

    var body: some View {
        VStack(spacing: 0) {
            header.padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 10)
            if let error = runner.epicError {
                Banner(text: error, tone: .bad, icon: "xmark.octagon.fill").padding(.horizontal, 14).padding(.bottom, 8)
            }
            FittingScroll {
                VStack(alignment: .leading, spacing: 0) {
                    if let detail = runner.epicDetail {
                        if detail.children.isEmpty {
                            Text("Esta épica no tiene sub-issues.").font(.lh(12)).foregroundStyle(.tertiary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        ForEach(Array(detail.children.enumerated()), id: \.element.ref) { i, child in
                            if i > 0 { Divider().opacity(0.4).padding(.vertical, 6) }
                            EpicChildRow(runner: runner, child: child)
                        }
                    } else if runner.epicError == nil {
                        HStack { ProgressView().controlSize(.small); Text("Leyendo los sub-issues…").foregroundStyle(.secondary) }
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .card()
                .padding(.horizontal, 14)
                .padding(.bottom, 12)
            }
        }
    }

    private var header: some View {
        let ref = runner.epicRef ?? ""
        let epic = runner.epicDetail?.epic
        return HStack(alignment: .top, spacing: 8) {
            IconButton(symbol: "chevron.left", help: "Volver") { runner.closeEpic() }
            VStack(alignment: .leading, spacing: 5) {
                Text("Épica").font(.lh(17, .bold))
                if let epic {
                    Text(cleanTitle(epic.title)).font(.lh(12)).foregroundStyle(.secondary).lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: 6) {
                    Button { runner.openTask(ref) } label: { refTag(ref) }.buttonStyle(.plain).fixedSize()
                        .help("Abrir \(ref) en GitHub")
                    if let epic { Chip(text: "\(epic.done)/\(epic.total) cerrados", tone: .ok, icon: "checkmark") }
                }
                if let epic { ProgressBar(value: epic.total == 0 ? 0 : Double(epic.done) / Double(epic.total)) }
            }
            Spacer(minLength: 0)
        }
    }
}

/// Un sub-issue: ✓ si cerró; su título, la ref, la columna (o «fuera del board»), el PR y qué lo bloquea.
struct EpicChildRow: View {
    @ObservedObject var runner: RunnerModel
    let child: EpicChild

    private var closed: Bool { child.state == "closed" }
    private var onBoard: Bool { !closed && child.status != nil }

    var body: some View {
        Button { runner.openEpicChild(child) } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: closed ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(closed ? Color.green : Color.secondary)
                VStack(alignment: .leading, spacing: 4) {
                    Text(cleanTitle(child.title)).font(.lh(12.5, closed ? .regular : .semibold))
                        .foregroundStyle(closed ? Color.secondary : Color.primary)
                        .lineLimit(2).multilineTextAlignment(.leading)
                    FlowLayout {
                        refTag(child.ref)
                        Chip(text: closed ? "cerrado" : child.status ?? "fuera del board", tone: onBoard ? .info : .neutral)
                        if let pr = child.pr { Chip(text: "PR #\(pr.number)", tone: .info) }
                        if let blockers = child.blocked_by, !blockers.isEmpty {
                            Chip(text: "espera \(blockers.map(shortRef).joined(separator: ", "))", tone: .warn, icon: "lock.fill")
                        }
                    }
                }
                Spacer(minLength: 4)
                Image(systemName: onBoard ? "chevron.right" : "arrow.up.right")
                    .font(.system(size: 10, weight: .semibold)).foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(onBoard ? "Ver la traza de \(child.ref)" : "Abrir \(child.ref) en GitHub")
        .contextMenu {
            Button("Abrir issue en GitHub") { runner.openTask(child.ref) }
            if let pr = child.pr, let url = URL(string: pr.url) { Button("Abrir PR") { NSWorkspace.shared.open(url) } }
        }
    }
}

extension EpicDetail {
    /// Para `--screenshot`: las tareas de la épica que trae la bandeja de prueba, más dos ya cerradas.
    static func fixture(_ view: EpicView) -> EpicDetail {
        let base = view.epic.ref.split(separator: "#").first.map(String.init) ?? ""
        let closed = [("Registrar «Tarea creada» con el responsable", 4190), ("Modelo de eventos del lead", 4191)].map { title, n in
            EpicChild(ref: "\(base)#\(n)", title: title, url: "https://github.com/\(base)/issues/\(n)", state: "closed",
                      status: nil, blocked_by: nil, pr: nil)
        }
        let open = view.items.map { item in
            EpicChild(ref: item.ref, title: item.title, url: item.url, state: "open", status: item.status ?? "Build",
                      blocked_by: item.blocked_by, pr: item.pr)
        }
        let away = EpicChild(ref: "la-haus/lh-seller-v2-frontend#77", title: "La vista del historial en el CRM",
                             url: "https://github.com/la-haus/lh-seller-v2-frontend/issues/77", state: "open",
                             status: nil, blocked_by: nil, pr: nil)
        return EpicDetail(epic: .init(ref: view.epic.ref, title: view.epic.title, url: "https://github.com/\(base)/issues/\(view.epic.ref.split(separator: "#").last ?? "")",
                                      done: view.epic.done, total: view.epic.total),
                          children: closed + open + [away])
    }
}
