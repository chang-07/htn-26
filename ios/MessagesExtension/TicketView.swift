import SwiftUI

/// How the extension is being shown; drives which layout draws.
final class PresentationInfo: ObservableObject {
    /// True when rendering inline in the transcript bubble (no room, no scroll).
    @Published var isTranscript = true
    /// True only for the full-height Messages extension sheet.
    @Published var isExpanded = false
}

/// The plan card, in the system design language — the same family as Linq's
/// own experience cards: SF type, semantic colors, capsules, SF Symbols.
/// Two layouts: a fixed compact card for the transcript bubble, and the full
/// interactive list for the expanded sheet.
struct TicketView: View {
    @ObservedObject var store: PlanStore
    @ObservedObject var presentation: PresentationInfo

    private var statusLabel: String {
        switch store.plan?.status {
        case "voting": return "Voting"
        case "booking": return "Booking…"
        case "booked": return "Booked"
        case "handoff": return "Yours to finish"
        case "failed": return "Failed"
        default: return "Plan"
        }
    }

    private var statusTint: Color {
        switch store.plan?.status {
        case "booked": return .green
        case "failed": return .red
        default: return .accentColor
        }
    }

    var body: some View {
        Group {
            if let plan = store.plan {
                if presentation.isTranscript {
                    compact(plan)
                } else {
                    expanded(plan)
                }
            } else {
                VStack(spacing: 8) {
                    ProgressView()
                    Text(store.failed ? "Can't reach the planner" : "Loading plan…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Whim.paper)
        .whimPage()
        .animation(.snappy(duration: 0.35), value: store.plan)
        .onAppear { store.start() }
        .onDisappear { store.stop() }
    }

    // MARK: - Shared pieces

    private func header(_ plan: PlanState, votes: Int) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            // No context label: the Messages chrome overlaps the sheet's top
            // left, so the word there just gets covered by the app logo.
            WhimHeader(context: "", chipText: statusLabel, chipTint: statusTint,
                       chipVisible: presentation.isTranscript)
            Text(plan.title.isEmpty ? "No plan yet" : plan.title)
                .font(.system(.title3, design: .rounded).weight(.bold))
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
                .lineLimit(presentation.isTranscript ? 2 : nil)
            if !plan.options.isEmpty, presentation.isTranscript {
                // The bubble has room for the options or for giant numbers, not both.
                Text("\(votes) \(votes == 1 ? "vote" : "votes") · \(plan.options.count) options")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
            } else if !plan.options.isEmpty {
                HStack(alignment: .firstTextBaseline, spacing: 18) {
                    HeroStat(value: "\(votes)", label: votes == 1 ? "vote" : "votes")
                    HeroStat(value: "\(plan.options.count)", label: plan.options.count == 1 ? "option" : "options", tint: .secondary)
                }
            }
        }
    }

    private func voteBadge(_ count: Int) -> some View {
        Text("\(count)")
            .font(.subheadline.weight(.semibold))
            .monospacedDigit()
            .foregroundStyle(count > 0 ? Color.accentColor : Color.secondary)
            .padding(.horizontal, 9)
            .padding(.vertical, 3)
            .background(
                (count > 0 ? Color.accentColor.opacity(0.12) : Color(uiColor: .secondarySystemFill)),
                in: Capsule()
            )
    }

    // MARK: - Transcript bubble: fixed, no scrolling, essentials only.

    private func compact(_ plan: PlanState) -> some View {
        let votes = plan.counts.values.reduce(0, +)
        let shown = 3
        return VStack(alignment: .leading, spacing: 8) {
            header(plan, votes: votes)
            if !plan.options.isEmpty {
                Divider()
                ForEach(plan.options.prefix(shown)) { option in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Image(systemName: plan.chosenOptionId == option.id ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(plan.chosenOptionId == option.id ? .green : Color(uiColor: .tertiaryLabel))
                            .font(.body)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(option.title)
                                .font(.subheadline.weight(.semibold))
                                .lineLimit(1)
                            if let sub = option.subtitle, !sub.isEmpty {
                                Text(sub).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                        Spacer(minLength: 6)
                        voteBadge(plan.counts[option.id] ?? 0)
                    }
                }
                Spacer(minLength: 0)
                HStack {
                    if plan.options.count > shown {
                        Text("+\(plan.options.count - shown) more")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if plan.status == "voting" {
                        Label("Tap to vote", systemImage: "hand.tap")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Color.accentColor)
                    }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // MARK: - Expanded sheet: the full interactive ballot.

    private func expanded(_ plan: PlanState) -> some View {
        let votes = plan.counts.values.reduce(0, +)
        let open = plan.status == "voting"
        return ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header(plan, votes: votes)
                if !plan.options.isEmpty {
                    VStack(spacing: 8) {
                        ForEach(plan.options) { option in
                            optionRow(option, plan: plan, open: open)
                        }
                    }
                }
                if plan.options.isEmpty {
                    // Never a dead end: an empty plan is an invitation to make one.
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Tell Whim what the group's thinking — options land here and everyone votes.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        AskWhimView(base: store.base, chat: store.chat)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                } else if open {
                    Text("Tap an option to vote. Everyone in the chat sees the tally live.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let note = plan.bookingNote, !note.isEmpty {
                    Divider()
                    Label(note, systemImage: plan.status == "booked" ? "checkmark.seal.fill" : "info.circle")
                        .font(.subheadline)
                        .foregroundStyle(plan.status == "booked" ? .green : .secondary)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
    }

    private func optionRow(_ option: PlanOption, plan: PlanState, open: Bool) -> some View {
        let mine = store.mine == option.id
        let won = plan.chosenOptionId == option.id
        let lost = plan.chosenOptionId != nil && !won

        return Button {
            guard open else { return }
            store.vote(option.id)
        } label: {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: won ? "checkmark.circle.fill" : mine ? "largecircle.fill.circle" : "circle")
                    .font(.title3)
                    .foregroundStyle(won ? .green : mine ? Color.accentColor : Color(uiColor: .tertiaryLabel))
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.title)
                        .font(.body.weight(.medium))
                        .foregroundStyle(lost ? Color.secondary : Color.primary)
                        .multilineTextAlignment(.leading)
                    if let sub = option.subtitle, !sub.isEmpty {
                        Text(sub).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                    }
                    if let avail = option.availability, !avail.isEmpty {
                        Label(avail, systemImage: "clock")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                voteBadge(plan.counts[option.id] ?? 0)
            }
            .padding(12)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(mine ? Color.accentColor.opacity(0.08) : Color(uiColor: .secondarySystemBackground))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(mine ? Color.accentColor.opacity(0.5) : .clear, lineWidth: 1.5)
            )
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!open)
    }
}
