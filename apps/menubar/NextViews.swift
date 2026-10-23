import SwiftUI

// «Próximo»: las épicas con su avance y lo que está por arrancar (las cards de Todo).

struct NextView: View {
    @ObservedObject var runner: RunnerModel

    var body: some View {
        let epics = runner.epics, feed = runner.shownFeed
        VStack(alignment: .leading, spacing: 14) {
            if !epics.isEmpty {
                InboxSection(title: "Épicas", count: epics.count) {
                    ForEach(Array(epics.enumerated()), id: \.element.id) { i, epic in
                        if i > 0 { Divider().opacity(0.4).padding(.vertical, 8) }
                        EpicRow(runner: runner, epic: epic)
                    }
                }
            }
            if !feed.ready.isEmpty {
                InboxSection(title: "Pueden arrancar", count: feed.ready.count) {
                    ForEach(Array(feed.ready.enumerated()), id: \.element.ref) { i, item in
                        if i > 0 { Divider().opacity(0.4).padding(.vertical, 6) }
                        FeedRow(runner: runner, item: item)
                    }
                }
            }
            if !feed.waiting.isEmpty {
                InboxSection(title: "Esperan a otra", count: feed.waiting.count) {
                    ForEach(Array(feed.waiting.enumerated()), id: \.element.ref) { i, item in
                        if i > 0 { Divider().opacity(0.4).padding(.vertical, 6) }
                        FeedRow(runner: runner, item: item)
                    }
                }
            }
            if epics.isEmpty, feed.ready.isEmpty, feed.waiting.isEmpty {
                Text("No hay nada por arrancar.").font(.lh(12)).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).card()
            }
        }
    }
}
