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
                        ForEach(epicGroups(detail.children), id: \.title) { group in
                            Text("\(group.title) \(group.items.count)").font(.lh(12, .semibold)).foregroundStyle(.secondary)
                                .padding(.top, group.title == epicGroups(detail.children).first?.title ? 0 : 12).padding(.bottom, 4)
                            ForEach(Array(group.items.enumerated()), id: \.element.ref) { i, child in
                                if i > 0 { Divider().opacity(0.4).padding(.vertical, 5) }
                                EpicChildRow(runner: runner, child: child)
                            }
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
        return VStack(alignment: .leading, spacing: 8) {
            RouteHeader(back: runner.backLabel, title: "Épica · \(epic.map { shortEpic(cleanTitle($0.title)) } ?? shortRef(ref))") { runner.closeEpic() }
            if let epic {
                Text(cleanTitle(epic.title)).font(.lh(15, .semibold)).fixedSize(horizontal: false, vertical: true)
                HStack {
                    ProgressBar(value: epic.total == 0 ? 0 : Double(epic.done) / Double(epic.total))
                    Text("\(epic.done) de \(epic.total)").font(.lh(11.5, .semibold)).foregroundStyle(.secondary).fixedSize()
                }
                if !summary.isEmpty { Text(summary).font(.lh(12)).foregroundStyle(.secondary) }
            }
            HStack(spacing: 6) {
                Button("Abrir la épica en GitHub ↗") { runner.openTask(ref) }.buttonStyle(PillButtonStyle(compact: true)).fixedSize()
                if let item = runner.inbox?.items.first(where: { $0.epic?.ref == ref }), let onAsk = runner.onAsk {
                    Button { onAsk(item) } label: { Text("✦ ¿Qué le falta?").foregroundStyle(Palette.ai) }
                        .buttonStyle(PillButtonStyle(compact: true)).fixedSize()
                        .help("Preguntarle al asistente (con una tarea de la épica como contexto)")
                }
            }
        }
    }

    /// «2 te esperan · 2 corriendo · 1 bloqueada», con lo que la bandeja sabe de sus hijos.
    private var summary: String {
        let ref = runner.epicRef ?? ""
        let items = runner.inbox?.items.filter { $0.epic?.ref == ref } ?? []
        let waiting = items.filter(\.isDecision).count, running = items.filter { $0.group == "run" }.count
        let blocked = runner.epicDetail?.children.filter { $0.state == "open" && !($0.blocked_by ?? []).isEmpty }.count ?? 0
        var parts: [String] = []
        if waiting > 0 { parts.append("\(waiting) te \(waiting == 1 ? "espera" : "esperan")") }
        if running > 0 { parts.append("\(running) corriendo") }
        if blocked > 0 { parts.append("\(blocked) bloqueada\(blocked == 1 ? "" : "s")") }
        return parts.joined(separator: " · ")
    }
}

/// Los sub-issues agrupados por columna (Done arriba, como el board) y «Fuera del board» al final: cerrados o sin card.
func epicGroups(_ children: [EpicChild]) -> [(title: String, items: [EpicChild])] {
    var order: [String] = []
    var byStatus: [String: [EpicChild]] = [:]
    var away: [EpicChild] = []
    for child in children {
        guard child.state == "open", let status = child.status else {
            // un cerrado con columna (Done) va en su columna; uno sin card, afuera
            if child.state == "closed", let status = child.status {
                if byStatus[status] == nil { order.append(status) }
                byStatus[status, default: []].append(child)
            } else {
                away.append(child)
            }
            continue
        }
        if byStatus[status] == nil { order.append(status) }
        byStatus[status, default: []].append(child)
    }
    let rank = { (s: String) -> Int in ["done": 0, "review": 1, "build": 2, "refined": 3, "refine": 4, "todo": 5][s.lowercased()] ?? 6 }
    var groups = order.sorted { rank($0) < rank($1) }.map { (title: $0, items: byStatus[$0] ?? []) }
    if !away.isEmpty { groups.append((title: "Fuera del board", items: away)) }
    return groups
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
                        if let item = runner.inbox?.items.first(where: { $0.ref == child.ref }) {
                            if item.isDecision { Chip(text: "te espera", tone: .warn) } else if item.group == "run" { Chip(text: "corriendo", tone: .ok) }
                        }
                        let unlocks = runner.epicDetail?.children.filter { $0.state == "open" && ($0.blocked_by ?? []).contains(child.ref) }.count ?? 0
                        if !closed, unlocks > 0 { Chip(text: "cerrarla destraba \(unlocks)", tone: .ok, icon: "lock.open.fill") }
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
