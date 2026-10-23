import SwiftUI

// «Para mí»: lo que espera algo tuyo. La primera decisión va como hero, con su acción a la vista; las demás, cortas.
// Al final, las mejoras que propuso la retro.

struct ForMeView: View {
    @ObservedObject var runner: RunnerModel

    var body: some View {
        let decisions = runner.decisions
        VStack(alignment: .leading, spacing: 12) {
            if decisions.isEmpty {
                EmptyMine(runner: runner)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(decisions.enumerated()), id: \.element.ref) { i, item in
                        if i > 0 { Divider().opacity(0.4).padding(.vertical, 5) }
                        TaskRow(runner: runner, item: item, primary: i == 0)
                    }
                }
                .card()
            }
            let improvements = runner.improvements.count
            if improvements > 0 {
                DashedLink(text: improvements == 1 ? "1 mejora propuesta por la retro" : "\(improvements) mejoras propuestas por la retro",
                           action: "Revisar") { runner.showImprovements() }
            }
        }
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
