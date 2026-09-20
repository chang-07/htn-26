import SwiftUI

// A stored ticket (venue, RSVP, paid receipt, match intro, plan snapshot),
// fetched once from /api/widget/<chat>/ticket/<id> and drawn natively in the
// system design language. Tickets never change after posting, so no polling.

struct TicketDoc: Codable {
    struct Row: Codable {
        let lead: String?
        let text: String
        let tail: String?
        let dim: Bool?
    }
    struct Stub: Codable {
        let big: String
        let label: String
    }
    let tone: String
    let metaLeft: String
    let metaRight: String?
    let title: String
    let rows: [Row]
    let stub: Stub
    let faces: [String]?
    let photoUrl: String?
}

struct TicketCardView: View {
    let base: URL
    let chat: String
    let ticketId: String
    @ObservedObject var presentation: PresentationInfo

    @State private var doc: TicketDoc?
    @State private var failed = false

    private var done: Bool { doc?.tone == "done" }
    private var tint: Color { done ? .green : .accentColor }

    var body: some View {
        Group {
            if let doc {
                card(doc)
            } else {
                VStack(spacing: 8) {
                    ProgressView()
                    Text(failed ? "Can't load this card" : "Loading…")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Whim.paper)
        .whimPage()
        .task { await load() }
    }

    private func load() async {
        let url = base.appendingPathComponent("api/widget/\(chat)/ticket/\(ticketId)")
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            doc = try JSONDecoder().decode(TicketDoc.self, from: data)
        } catch {
            failed = true
        }
    }

    @ViewBuilder
    private func card(_ doc: TicketDoc) -> some View {
        let rows = presentation.isTranscript ? Array(doc.rows.prefix(3)) : doc.rows
        let body = VStack(alignment: .leading, spacing: 10) {
            WhimHeader(context: doc.metaLeft, chipText: "\(doc.stub.big) \(doc.stub.label)", chipTint: tint)

            Text(doc.title)
                .font(.system(.title3, design: .rounded).weight(.bold))
                .fixedSize(horizontal: false, vertical: true)

            if let faces = doc.faces, !faces.isEmpty {
                HStack(spacing: -6) {
                    ForEach(Array(faces.prefix(6).enumerated()), id: \.offset) { _, initials in
                        Text(initials)
                            .font(.caption2.weight(.bold))
                            .frame(width: 26, height: 26)
                            .background(tint.opacity(0.15), in: Circle())
                            .overlay(Circle().strokeBorder(Color(uiColor: .systemBackground), lineWidth: 2))
                    }
                }
            }

            if !rows.isEmpty {
                Divider()
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        if let lead = row.lead, !lead.isEmpty {
                            Text(lead).font(.subheadline).frame(width: 22, alignment: .leading)
                        }
                        Text(row.text)
                            .font(.subheadline.weight(row.dim == true ? .regular : .medium))
                            .foregroundStyle(row.dim == true ? Color.secondary : Color.primary)
                            .lineLimit(presentation.isTranscript ? 1 : 3)
                        Spacer(minLength: 6)
                        if let tail = row.tail, !tail.isEmpty {
                            Text(tail).font(.footnote).foregroundStyle(.secondary).monospacedDigit()
                        }
                    }
                }
                if presentation.isTranscript, doc.rows.count > 3 {
                    Text("+\(doc.rows.count - 3) more")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .topLeading)

        if presentation.isTranscript {
            body.frame(maxHeight: .infinity, alignment: .topLeading)
        } else {
            ScrollView { body }
        }
    }
}
