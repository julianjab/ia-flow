import SwiftUI

// «Para mí»: lo que espera algo tuyo. La primera decisión va como hero, con su botón principal, el PR y ⋯; las demás,
// filas cortas sin botón (la pista «‹ acción» dice qué sale al deslizarla). Deslizar a la izquierda: la acción principal
// y Posponer; a la derecha: Fijar arriba. Varias del mismo tipo van juntas en un grupo. Arriba, el orden; al final,
// las pospuestas (plegadas) y las mejoras de la retro. Confirmar va en el lugar del botón y un error queda pegado a su
// card con qué hacer.

struct ForMeView: View {
    @ObservedObject var runner: RunnerModel
    @State private var showSnoozed = false
    @AppStorage("swipeHintSeen") private var swipeHintSeen = false

    var body: some View {
        let mine = runner.mine
        let shown = mine.shown
        VStack(alignment: .leading, spacing: 12) {
            if runner.decisions.count > 1 { orderBar }
            if shown.isEmpty {
                EmptyMine(runner: runner)
            } else {
                DecisionHero(runner: runner, item: shown[0])
                let blocks = Self.blocks(Array(shown.dropFirst()))
                if !blocks.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(blocks) { block in
                            if block.items.count > 1, let action = block.action {
                                DecisionGroup(runner: runner, items: block.items, action: action)
                            } else {
                                DecisionRow(runner: runner, item: block.items[0]).card()
                            }
                        }
                    }
                    if !swipeHintSeen {
                        HStack(alignment: .top, spacing: 6) {
                            Text("Con dos dedos a la izquierda: la acción principal y Posponer. A la derecha: Fijar arriba. Clic la card: el detalle con todas las acciones.")
                                .font(.lh(11.5)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                            Button { swipeHintSeen = true } label: { Image(systemName: "xmark").font(.system(size: 9, weight: .bold)) }
                                .buttonStyle(.plain).foregroundStyle(.tertiary).help("Entendido")
                        }
                        .padding(.horizontal, 4)
                    }
                }
            }
            if !mine.snoozed.isEmpty { snoozedGroup(mine.snoozed) }
            let improvements = runner.shownImprovements.count
            if improvements > 0 {
                DashedLink(text: improvements == 1 ? "1 mejora propuesta por la retro" : "\(improvements) mejoras propuestas por la retro",
                           action: "Revisar") { runner.showImprovements() }
            }
        }
    }

    private var orderBar: some View {
        HStack(spacing: 8) {
            Text("Orden").font(.lh(11.5)).foregroundStyle(.secondary)
            Segmented(options: TriageOrder.allCases.map { SegmentOption(id: $0.rawValue, title: $0.title) },
                      selected: runner.order.rawValue, compact: true) { id in
                runner.order = TriageOrder(rawValue: id) ?? .priority
            }
        }
    }

    /// «Pospuestas · N»: plegado al final; vuelven solas.
    private func snoozedGroup(_ items: [InboxItem]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { withAnimation(.easeOut(duration: 0.15)) { showSnoozed.toggle() } } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right").font(.system(size: 8.5, weight: .bold)).foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(showSnoozed ? 90 : 0))
                    Text("Pospuestas · \(items.count)").font(.lh(12.5, .semibold)).foregroundStyle(.secondary)
                    Text("vuelven cuando cambien").font(.lh(11.5)).foregroundStyle(.tertiary)
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if showSnoozed {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(items.enumerated()), id: \.element.ref) { i, item in
                        if i > 0 { Divider().opacity(0.4).padding(.vertical, 6) }
                        SnoozedRow(runner: runner, item: item)
                    }
                }
                .card()
            }
        }
    }

    /// Un bloque de Para mí: una fila sola o un grupo (dos o más del mismo tipo con la misma acción principal, sin texto).
    struct Block: Identifiable {
        let items: [InboxItem]
        let action: ActionView?
        var id: String { items.map(\.ref).joined(separator: ",") }
    }

    static func blocks(_ items: [InboxItem]) -> [Block] {
        var order: [String] = []
        var byKey: [String: [InboxItem]] = [:]
        for item in items {
            let main = mainAction(actionsOf(item))
            // sólo se agrupa lo que sale con un clic (confirmado): lo que pide texto va de a una
            let key = main.map { $0.comment == nil ? "\(item.kind)|\($0.id)" : item.ref } ?? item.ref
            if byKey[key] == nil { order.append(key) }
            byKey[key, default: []].append(item)
        }
        return order.compactMap { key in
            guard let group = byKey[key] else { return nil }
            return Block(items: group, action: group.count > 1 ? mainAction(actionsOf(group[0])) : nil)
        }
    }
}

/// Cómo se nombra el caso de una decisión y su color (el estado nunca va sólo por color: siempre con palabra).
func kindLabel(_ item: InboxItem) -> (text: String, color: Color) {
    switch item.kind {
    case "merge": return ("Merge", Palette.green)
    case "prd": return ("PRD", Palette.teal)
    case "doubt", "prerequisite": return ("Pregunta", Palette.amber)
    case "crash": return ("Falló", Palette.red)
    case "stale": return ("Quieta", Palette.amber)
    case "review": return ("Review", Palette.link)
    case "ci": return ("CI", Palette.link)
    case "agent": return (stageName(item), Palette.green)
    default: return (item.kind.prefix(1).uppercased() + item.kind.dropFirst(), Color.secondary)
    }
}

/// «Review · subscriptions #4281 · 7 h» (o «Fijada · …» en ámbar).
struct DecisionMeta: View {
    @ObservedObject var runner: RunnerModel
    let item: InboxItem

    var body: some View {
        let kind = kindLabel(item)
        let pinned = runner.isPinned(item)
        HStack(spacing: 4) {
            if pinned { Image(systemName: "pin.fill").font(.system(size: 8.5, weight: .bold)).foregroundStyle(Palette.amber) }
            Text(pinned ? "Fijada" : kind.text).font(.lh(11.5, .semibold)).foregroundStyle(pinned ? Palette.amber : kind.color)
            Text("·").foregroundStyle(.tertiary)
            Text(refLabel(item.ref)).font(.mono(11)).foregroundStyle(.secondary).lineLimit(1)
            if let age = item.age {
                Text("·").foregroundStyle(.tertiary)
                Text(age == "ahora" ? age : "hace \(age)").font(.lh(11.5)).foregroundStyle(.tertiary).lineLimit(1)
            }
        }
        .help(pinned ? "Fijada arriba · \(kind.text)" : kind.text)
    }
}

/// La razón sin repetir el PR (va como botón).
func reason(_ item: InboxItem) -> String {
    var why = item.why
    if let pr = item.pr { why = why.replacingOccurrences(of: " · PR #\(pr.number)", with: "") }
    return why
}

/// La primera decisión: todo a la vista, con su botón principal, el PR y ⋯.
struct DecisionHero: View {
    @ObservedObject var runner: RunnerModel
    let item: InboxItem

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            DecisionMeta(runner: runner, item: item)
            Text(item.displayTitle).font(.lh(14.5, .semibold)).lineLimit(3).multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(reason(item)).font(.lh(12.5)).foregroundStyle(.secondary).lineLimit(2).fixedSize(horizontal: false, vertical: true)
            if let said = item.agent_said {
                Text("«\(said)»").font(.lh(12)).foregroundStyle(.primary.opacity(0.75)).lineLimit(3)
            }
            if let epic = item.epic {
                Button { runner.showEpic(epic.ref) } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "square.stack.3d.up").font(.system(size: 9.5, weight: .semibold))
                        Text("Épica «\(shortEpic(epic.displayTitle))» · \(epic.done) de \(epic.total)").lineLimit(1)
                    }
                    .font(.lh(11.5)).foregroundStyle(Palette.link)
                }
                .buttonStyle(.plain)
                .help("Épica \(epic.ref): \(epic.title)")
            }
            BlockersLine(runner: runner, item: item)
            if runner.inlineConfirm?.ref == item.ref {
                InlineConfirmView(runner: runner, item: item)
            } else {
                buttons
            }
            if let failure = runner.failures[item.ref] { ActionErrorView(runner: runner, failure: failure) }
            if runner.snoozePicking == item.ref { SnoozePicker(runner: runner, item: item) }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.card))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.line))
        .contentShape(Rectangle())
        .onTapGesture { runner.showTask(item) }
        .contextMenu { TaskMenu(runner: runner, item: item) }
    }

    private var buttons: some View {
        let busy = runner.busy.contains(item.ref)
        return HStack(spacing: 6) {
            if let main = mainAction(actionsOf(item)) {
                Button { runner.triggerInline(main, on: item) } label: {
                    if busy { ProgressView().controlSize(.small).scaleEffect(0.5).frame(width: 50, height: 14) }
                    else { Text(main.confirms || main.comment != nil ? "\(main.label)…" : main.label) }
                }
                .buttonStyle(PillButtonStyle(prominent: true, tint: main.id == "stop" ? Palette.red : Palette.blue))
                .fixedSize().disabled(busy)
            }
            if let pr = item.pr {
                Button("PR #\(pr.number)") { runner.openPR(item) }.buttonStyle(PillButtonStyle()).fixedSize()
                    .help("Abrir el PR #\(pr.number) en GitHub")
            }
            Spacer(minLength: 0)
            Menu { TaskMenu(runner: runner, item: item, skip: mainAction(actionsOf(item))?.id) } label: {
                Image(systemName: "ellipsis").font(.system(size: 12, weight: .semibold)).frame(width: 30, height: 26)
                    .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Palette.control))
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().foregroundStyle(.secondary)
            .help("Todas las acciones")
        }
        .padding(.top, 2)
    }
}

/// «Funnel configurable por empresa — etapas…» → «Funnel configurable por empresa».
func shortEpic(_ title: String) -> String {
    let head = title.components(separatedBy: " — ").first ?? title
    return head.count > 34 ? String(head.prefix(33)) + "…" : head
}

/// Una decisión corta: meta, el título en dos líneas, la razón y la pista «‹ acción». Sin botones: se desliza.
struct DecisionRow: View {
    @ObservedObject var runner: RunnerModel
    let item: InboxItem

    var body: some View {
        let main = mainAction(actionsOf(item))
        VStack(alignment: .leading, spacing: 6) {
            SwipeRow(id: "mine:\(item.ref)", actions: trailing(main), leading: leading) {
                VStack(alignment: .leading, spacing: 4) {
                    DecisionMeta(runner: runner, item: item)
                    Text(item.displayTitle).font(.lh(13.5, .semibold)).lineLimit(2).multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(reason(item)).font(.lh(12)).foregroundStyle(.secondary).lineLimit(1)
                        Spacer(minLength: 4)
                        if let main {
                            if runner.busy.contains(item.ref) {
                                ProgressView().controlSize(.small).scaleEffect(0.5).frame(width: 14, height: 12)
                            } else {
                                Text("‹ \(main.label)").font(.lh(11.5)).foregroundStyle(.tertiary).fixedSize()
                            }
                        }
                    }
                }
                .contentShape(Rectangle())
                .onTapGesture { runner.showTask(item) }
                .help("\(item.title)\n\nClic: el detalle · deslizá: \(main?.label ?? "acciones"), Posponer o Fijar · clic derecho: todas")
            }
            .contextMenu { TaskMenu(runner: runner, item: item) }
            .accessibilityActions {
                if let main { Button(main.label) { runner.triggerInline(main, on: item) } }
                Button("Posponer") { runner.snoozePicking = item.ref }
                Button(runner.isPinned(item) ? "Desfijar" : "Fijar arriba") { runner.togglePin(item) }
            }
            if runner.inlineConfirm?.ref == item.ref { InlineConfirmView(runner: runner, item: item) }
            if let failure = runner.failures[item.ref] { ActionErrorView(runner: runner, failure: failure) }
            if runner.snoozePicking == item.ref { SnoozePicker(runner: runner, item: item) }
        }
    }

    /// A la izquierda: la acción principal (azul) y Posponer (gris).
    private func trailing(_ main: ActionView?) -> [SwipeAction] {
        var out: [SwipeAction] = []
        if let main, !runner.busy.contains(item.ref) {
            out.append(SwipeAction(id: main.id, icon: actionIcon(main.id), label: main.label,
                                   color: main.id == "stop" ? Palette.red : Palette.blue) { runner.triggerInline(main, on: item) })
        }
        out.append(SwipeAction(id: "snooze", icon: "moon.zzz", label: "Posponer", color: .gray) { runner.snoozePicking = item.ref })
        return out
    }

    /// A la derecha: Fijar arriba (ámbar).
    private var leading: [SwipeAction] {
        let pinned = runner.isPinned(item)
        return [SwipeAction(id: "pin", icon: pinned ? "pin.slash" : "pin.fill", label: pinned ? "Desfijar" : "Fijar arriba",
                            color: Color(red: 0.80, green: 0.60, blue: 0.10)) { runner.togglePin(item) }]
    }
}

func actionIcon(_ action: String) -> String {
    switch action {
    case "merge": return "arrow.triangle.merge"
    case "approve_prd": return "checkmark.seal"
    case "stop": return "stop.fill"
    case "answer_and_unblock", "comment": return "text.bubble"
    case "retry", "relaunch", "rerun_review", "rerun_stage": return "arrow.clockwise"
    default: return "bolt.fill"
    }
}

/// Varias del mismo tipo: «Mergear 2 PRs», una fila y un botón por tarea, y «Mergear los 2…».
struct DecisionGroup: View {
    @ObservedObject var runner: RunnerModel
    let items: [InboxItem]
    let action: ActionView

    var body: some View {
        let kind = kindLabel(items[0])
        VStack(alignment: .leading, spacing: 8) {
            Text("\(kind.text) · \(items.count)").font(.lh(11.5, .semibold)).foregroundStyle(kind.color)
            Text(title).font(.lh(14, .semibold))
            ForEach(Array(items.enumerated()), id: \.element.ref) { i, item in
                if i > 0 { Divider().opacity(0.4) }
                row(item)
            }
            Button("\(action.label) los \(items.count)…") {
                runner.triggerAll(action, on: items.filter { actionsOf($0).contains { $0.id == action.id } })
            }
            .buttonStyle(PillButtonStyle(compact: true)).fixedSize()
            .padding(.top, 2)
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.card))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.line))
    }

    private var title: String {
        items[0].kind == "merge" ? "Mergear \(items.count) PRs" : "\(action.label): \(items.count) tareas"
    }

    private func row(_ item: InboxItem) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.displayTitle).font(.lh(12.5, .semibold)).lineLimit(1)
                    Text([refLabel(item.ref), item.pr.map { "PR #\($0.number)" }, item.age].compactMap { $0 }.joined(separator: " · "))
                        .font(.mono(10.5)).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 4)
                if runner.inlineConfirm?.ref != item.ref {
                    let busy = runner.busy.contains(item.ref)
                    Button(action.confirms ? "\(action.label)…" : action.label) { runner.triggerInline(action, on: item) }
                        .buttonStyle(PillButtonStyle(prominent: true, compact: true)).fixedSize().disabled(busy)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { runner.showTask(item) }
            .contextMenu { TaskMenu(runner: runner, item: item) }
            if runner.inlineConfirm?.ref == item.ref { InlineConfirmView(runner: runner, item: item) }
            if let failure = runner.failures[item.ref] { ActionErrorView(runner: runner, failure: failure) }
        }
    }
}

/// La confirmación en el lugar del botón: qué se firma, dónde y con quién; «Cancelar» y «<Acción> ahora».
struct InlineConfirmView: View {
    @ObservedObject var runner: RunnerModel
    let item: InboxItem

    var body: some View {
        if let pending = runner.inlineConfirm, let action = actionsOf(item).first(where: { $0.id == pending.action }) {
            let text = runner.confirmText(action, on: item)
            VStack(alignment: .leading, spacing: 8) {
                Text(text.title).font(.lh(12.5, .semibold))
                Text(text.detail).font(.lh(12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    Button("Cancelar") { runner.inlineConfirm = nil }.buttonStyle(PillButtonStyle(compact: true)).fixedSize()
                        .keyboardShortcut(.cancelAction)
                    Button("\(action.label) ahora") { runner.confirmInline(item) }
                        .buttonStyle(PillButtonStyle(prominent: true, tint: action.id == "stop" ? Palette.red : Palette.blue, compact: true))
                        .fixedSize().keyboardShortcut(.defaultAction)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Palette.blue.opacity(0.12)))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.blue.opacity(0.4)))
        }
    }
}

/// «No se pudo <verbo>: <motivo>.» + «→ qué hacer», «Reintentar» (y «Ver En curso» si es la capacidad).
struct ActionErrorView: View {
    @ObservedObject var runner: RunnerModel
    let failure: ActionFailure

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                Text(failure.text).font(.lh(12, .semibold)).foregroundStyle(Palette.red).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                Button { runner.failures[failure.item.ref] = nil } label: { Image(systemName: "xmark").font(.system(size: 9, weight: .bold)) }
                    .buttonStyle(.plain).foregroundStyle(.secondary).help("Cerrar")
            }
            Text("→ \(failure.hint)").font(.lh(12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) {
                Button("Reintentar") { runner.failures[failure.item.ref] = nil; runner.send(failure.action, on: failure.item, comment: nil) }
                    .buttonStyle(PillButtonStyle(compact: true)).fixedSize()
                if failure.aboutCapacity {
                    Button("Ver En curso") { runner.goHome(.running) }.buttonStyle(PillButtonStyle(compact: true)).fixedSize()
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Palette.red.opacity(0.1)))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.red.opacity(0.4)))
        .accessibilityElement(children: .combine)
    }
}

/// «Posponer «<título>»»: hasta que cambie algo, 1 día, 1 semana o una fecha.
struct SnoozePicker: View {
    @ObservedObject var runner: RunnerModel
    let item: InboxItem
    @State private var picking = false
    @State private var date = Date().addingTimeInterval(3 * 86_400)

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Posponer «\(item.displayTitle)»").font(.lh(12.5, .semibold)).lineLimit(1)
                Spacer(minLength: 4)
                Button { runner.snoozePicking = nil } label: { Image(systemName: "xmark").font(.system(size: 9, weight: .bold)) }
                    .buttonStyle(.plain).foregroundStyle(.secondary).help("Cancelar").keyboardShortcut(.cancelAction)
            }
            FlowLayout {
                Button("Hasta que cambie algo") { runner.snooze(item, .untilChange) }.buttonStyle(PillButtonStyle(prominent: true, compact: true))
                Button("1 día") { runner.snooze(item, .day) }.buttonStyle(PillButtonStyle(compact: true))
                Button("1 semana") { runner.snooze(item, .week) }.buttonStyle(PillButtonStyle(compact: true))
                Button("Elegir fecha…") { picking.toggle() }.buttonStyle(PillButtonStyle(compact: true))
            }
            if picking {
                HStack(spacing: 8) {
                    DatePicker("Hasta", selection: $date, in: Date()..., displayedComponents: [.date])
                        .datePickerStyle(.compact).labelsHidden().fixedSize()
                    Button("Posponer") { runner.snooze(item, .date(Calendar.current.startOfDay(for: date).addingTimeInterval(9 * 3600))) }
                        .buttonStyle(PillButtonStyle(prominent: true, compact: true)).fixedSize()
                }
            }
            Text("Vuelve sola cuando cambie algo en la tarea: un commit, un review o el CI.")
                .font(.lh(11.5)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Palette.control))
    }
}

/// Una pospuesta: hasta cuándo y «Volver a mostrar».
struct SnoozedRow: View {
    @ObservedObject var runner: RunnerModel
    let item: InboxItem

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.displayTitle).font(.lh(12.5)).foregroundStyle(.secondary).lineLimit(1)
                Text("\(refLabel(item.ref)) · \(until)").font(.mono(10.5)).foregroundStyle(.tertiary).lineLimit(1)
            }
            Spacer(minLength: 4)
            Button("Volver a mostrar") { runner.unsnooze(item) }.buttonStyle(PillButtonStyle(compact: true)).fixedSize()
        }
        .contentShape(Rectangle())
        .onTapGesture { runner.showTask(item) }
        .contextMenu { TaskMenu(runner: runner, item: item) }
    }

    private var until: String {
        guard let date = runner.snoozeEntry(item)?.until else { return "hasta que cambie algo" }
        return "hasta el \(RunnerModel.dayFormat.string(from: date))"
    }
}

/// «Nada te espera»: qué corre y qué espera, y el link a En curso.
struct EmptyMine: View {
    @ObservedObject var runner: RunnerModel

    var body: some View {
        let running = runner.running.count, queued = runner.queued.count
        VStack(spacing: 8) {
            Image(systemName: "checkmark.circle").font(.system(size: 26, weight: .light)).foregroundStyle(Palette.green)
            Text("Nada te espera").font(.lh(15, .semibold))
            Text(summary(running, queued)).font(.lh(12)).foregroundStyle(.secondary).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if running + queued > 0 {
                Button("Ver En curso") { runner.tab = .running }.buttonStyle(PillButtonStyle(compact: true)).fixedSize()
            }
        }
        .frame(maxWidth: .infinity).padding(.vertical, 18)
        .card()
    }

    private func summary(_ running: Int, _ queued: Int) -> String {
        var parts: [String] = []
        if running > 0 { parts.append(running == 1 ? "1 corre" : "\(running) corren") }
        if queued > 0 { parts.append(queued == 1 ? "1 está en cola" : "\(queued) están en cola") }
        let head = parts.isEmpty ? "Nada corre." : parts.joined(separator: " y ") + "."
        return head + " Te avisa el ícono cuando algo te necesite."
    }
}
