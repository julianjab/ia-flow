import SwiftUI

// Pantallas del popover: la lista de servicios agrupada en tarjetas, el formulario de «Nuevo túnel» y las
// confirmaciones. Sólo dibujan lo que AppModel publica; las acciones van al modelo.

let popoverWidth: CGFloat = 420

struct RootView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ZStack(alignment: .bottom) {
            Group {
                if model.form != nil { TunnelFormView(model: model) } else { ListScreen(model: model) }
            }
            if let request = model.confirm {
                ConfirmCard(request: request, dismiss: { model.confirm = nil })
                    .padding(14)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            } else if let text = model.toast {
                ToastView(text: text).padding(.bottom, 62).transition(.opacity)
            }
        }
        .frame(width: popoverWidth)
        .animation(.easeOut(duration: 0.15), value: model.confirm == nil)
        .font(.lh(13))
    }
}

struct ConfirmCard: View {
    let request: ConfirmRequest
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(request.title).font(.lh(14, .bold))
            Text(request.detail).font(.lh(12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Cancelar", action: dismiss).buttonStyle(PillButtonStyle(tint: .secondary)).keyboardShortcut(.cancelAction)
                Button(request.confirmLabel) { dismiss(); request.action() }
                    .buttonStyle(PillButtonStyle(prominent: true, tint: request.destructive ? .red : .accentColor))
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.regularMaterial))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.primary.opacity(0.15)))
        .shadow(color: .black.opacity(0.25), radius: 14, y: 4)
    }
}

struct ToastView: View {
    let text: String

    var body: some View {
        Text(text).font(.lh(12, .semibold)).padding(.horizontal, 12).padding(.vertical, 7)
            .background(Capsule().fill(Color.primary.opacity(0.85)))
            .foregroundStyle(Color(nsColor: .windowBackgroundColor))
    }
}

// MARK: lista

struct ListScreen: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            header.padding(.horizontal, 14).padding(.top, 14).padding(.bottom, 10)
            FittingScroll {
                VStack(spacing: 14) {
                    ForEach(model.groups) { group in GroupCard(model: model, group: group) }
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 12)
            }
            Divider().opacity(0.5)
            footer.padding(.horizontal, 14).padding(.vertical, 10)
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(nsImage: appIcon(size: 30, running: model.activeCount > 0))
            VStack(alignment: .leading, spacing: 1) {
                Text("ia-flow").font(.lh(17, .bold))
                Text(subtitle).font(.lh(12)).foregroundStyle(.secondary)
            }
            Spacer()
            IconButton(symbol: "arrow.clockwise", help: "Actualizar") { model.refresh() }
        }
    }

    private var subtitle: String {
        let active = model.activeCount, total = model.services.count
        return active == 0 ? "Nada corriendo · \(total) servicios" : "\(active) de \(total) activos"
    }

    private var footer: some View {
        HStack(spacing: 4) {
            Button { model.beginForm() } label: { Label("Nuevo túnel", systemImage: "plus") }
                .buttonStyle(PillButtonStyle(prominent: true))
            Spacer()
            IconButton(symbol: "play.fill", help: "Iniciar todo") { model.startAll() }
            IconButton(symbol: "arrow.triangle.2.circlepath", help: "Reiniciar todo") { model.restartAll() }
            IconButton(symbol: "stop.fill", help: "Detener todo") { model.stopAll() }
            IconButton(symbol: "slider.horizontal.3", help: "Editar servicios.json") { model.editConfig() }
            IconButton(symbol: "power", help: "Salir (detiene los procesos que levantó)") { model.quit() }
        }
    }
}

struct GroupCard: View {
    @ObservedObject var model: AppModel
    let group: ServiceGroup

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(text: group.title, trailing: group.services.isEmpty ? nil : "\(running)/\(group.services.count)")
            VStack(spacing: 0) {
                if group.services.isEmpty {
                    Text("Sin túneles. Crea uno para exponer un puerto en julianjab.link.")
                        .font(.lh(12)).foregroundStyle(.tertiary).frame(maxWidth: .infinity, alignment: .leading)
                }
                ForEach(Array(group.services.enumerated()), id: \.element.spec.id) { index, service in
                    if index > 0 { Divider().opacity(0.4).padding(.vertical, 8) }
                    ServiceRow(model: model, service: service)
                }
            }
            .card()
        }
    }

    private var running: Int { group.services.filter { $0.state == .running }.count }
}

struct ServiceRow: View {
    @ObservedObject var model: AppModel
    let service: Service

    var body: some View {
        let state = service.state
        let external = service.isExternal
        HStack(spacing: 10) {
            PillSwitch(isOn: state == .running || state == .starting, enabled: !external && (state == .running || state == .stopped),
                       tint: state == .starting ? .orange : .green) { model.toggle(service) }
            VStack(alignment: .leading, spacing: 1) {
                Text(service.spec.name).font(.lh(14, .semibold)).lineLimit(1)
                Text(status(state, external)).font(.lh(11)).foregroundStyle(statusTone(state, external).color).lineLimit(1)
            }
            Spacer(minLength: 6)
            if external { Chip(text: "externo", tone: .warn, icon: "exclamationmark.triangle.fill") }
            if let port = service.spec.port { portChip(port) }
            actionsMenu(state)
        }
    }

    @ViewBuilder
    private func portChip(_ port: Int) -> some View {
        if service.spec.url != nil {
            Button { model.openURL(service) } label: { Chip(text: ":\(port)", tone: .info, icon: "arrow.up.right") }
                .buttonStyle(.plain).help("Abrir \(service.spec.url ?? "")")
        } else {
            Chip(text: ":\(port)")
        }
    }

    private func actionsMenu(_ state: Service.State) -> some View {
        Menu {
            Button("Reiniciar") { model.restart(service) }.disabled(state != .running)
            if service.spec.url != nil { Button("Abrir en el navegador") { model.openURL(service) } }
            Button("Ver log en iTerm") { model.openLog(service) }
            if service.spec.deleteCommand != nil {
                Divider()
                Button("Borrar túnel", role: .destructive) { model.requestDelete(service) }
            }
        } label: {
            Image(systemName: "ellipsis").font(.system(size: 12, weight: .semibold)).frame(width: 26, height: 26).contentShape(Circle())
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().foregroundStyle(.secondary)
    }

    private func status(_ state: Service.State, _ external: Bool) -> String {
        switch state {
        case .running: return service.spec.url?.replacingOccurrences(of: "https://", with: "").replacingOccurrences(of: "http://", with: "") ?? "corriendo"
        case .starting: return "iniciando…"
        case .stopping: return "deteniendo…"
        case .stopped: return external ? "puerto en uso" : "detenido"
        }
    }

    private func statusTone(_ state: Service.State, _ external: Bool) -> Tone {
        switch state {
        case .running: return .ok
        case .starting, .stopping: return .warn
        case .stopped: return external ? .warn : .neutral
        }
    }
}

// MARK: formulario de túnel

struct TunnelFormView: View {
    @ObservedObject var model: AppModel

    private var form: TunnelForm { model.form ?? TunnelForm() }
    private func edit(_ change: (inout TunnelForm) -> Void) {
        guard var f = model.form else { return }
        change(&f)
        model.form = f
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                IconButton(symbol: "chevron.left", help: "Volver") { model.cancelForm() }
                VStack(alignment: .leading, spacing: 1) {
                    Text("Nuevo túnel").font(.lh(17, .bold))
                    Text("Expone un puerto local en julianjab.link").font(.lh(12)).foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(.horizontal, 14).padding(.top, 14).padding(.bottom, 10)

            FittingScroll {
                VStack(alignment: .leading, spacing: 14) {
                    subdomain
                    port
                    Banner(text: "El túnel deja el puerto abierto a internet SIN autenticación.", icon: "globe")
                    if let notice = form.notice { noticeBanner(notice) }
                    if let error = form.error { Banner(text: error, tone: .bad, icon: "xmark.octagon.fill") }
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 12)
            }
            Divider().opacity(0.5)
            footer.padding(.horizontal, 14).padding(.vertical, 10)
        }
    }

    private var subdomain: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(text: "Subdominio")
            VStack(alignment: .leading, spacing: 8) {
                FieldBox(invalid: form.error?.hasPrefix("Subdominio") == true) {
                    HStack(spacing: 2) {
                        TextField("demo", text: Binding(get: { form.sub }, set: { v in edit { $0.sub = v; $0.error = nil; $0.notice = nil } }))
                            .onSubmit { model.submitForm() }
                            .disabled(form.checking)
                        Text(".julianjab.link").font(.lh(13)).foregroundStyle(.secondary)
                    }
                }
            }
            .card()
        }
    }

    private var port: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(text: "Puerto local", trailing: form.ports.isEmpty ? nil : "\(form.ports.count) en escucha")
            VStack(alignment: .leading, spacing: 10) {
                FieldBox(invalid: form.error?.hasPrefix("Puerto") == true) {
                    TextField("5173", text: Binding(get: { form.portText }, set: { v in edit { $0.portText = v; $0.error = nil; $0.notice = nil } }))
                        .onSubmit { model.submitForm() }
                        .disabled(form.checking)
                }
                if !form.ports.isEmpty {
                    FlowLayout {
                        ForEach(form.ports, id: \.port) { item in
                            SelectChip(label: ":\(item.port) · \(item.command)", selected: form.port == item.port) {
                                edit { $0.portText = String(item.port); $0.error = nil; $0.notice = nil }
                            }
                            .disabled(form.checking)
                        }
                    }
                }
            }
            .card()
        }
    }

    @ViewBuilder
    private func noticeBanner(_ notice: TunnelForm.Notice) -> some View {
        switch notice {
        case .expose(let port):
            Banner(text: "El puerto \(port) es el del runner o el gateway: quedaría abierto a internet sin autenticación.", tone: .bad) {
                Button("Exponer igual") { edit { $0.okExposePort = port; $0.notice = nil }; model.submitForm() }
                    .buttonStyle(PillButtonStyle(prominent: true, tint: .red))
            }
        case .overwriteDNS(let host):
            Banner(text: "\(host) ya tiene un registro DNS. Si lo reapuntas a este túnel, lo de antes deja de responder ahí.") {
                Button("Reapuntar") { edit { $0.okOverwriteHost = host; $0.notice = nil }; model.submitForm() }
                    .buttonStyle(PillButtonStyle(prominent: true, tint: .orange))
            }
        }
    }

    private var footer: some View {
        HStack {
            Text(summary).font(.lh(12)).foregroundStyle(.secondary).lineLimit(1)
            Spacer()
            Button("Cancelar") { model.cancelForm() }.buttonStyle(PillButtonStyle(tint: .secondary))
            Button { model.submitForm() } label: {
                if form.checking { ProgressView().controlSize(.small).scaleEffect(0.7).frame(width: 52) }
                else { Label("Crear", systemImage: "play.fill") }
            }
            .buttonStyle(PillButtonStyle(prominent: true, enabled: canCreate))
            .disabled(!canCreate)
            .keyboardShortcut(.defaultAction)
        }
    }

    private var canCreate: Bool { !form.cleanSub.isEmpty && form.port != nil && !form.checking }

    private var summary: String {
        guard !form.cleanSub.isEmpty, let port = form.port else { return "Elige subdominio y puerto" }
        return "\(form.cleanSub).julianjab.link → :\(port)"
    }
}
