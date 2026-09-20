import SwiftUI

/// How the extension is being shown; drives which layout draws.
final class PresentationInfo: ObservableObject {
    /// True when rendering inline in the transcript bubble (no room, no scroll).
    @Published var isTranscript = true
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
        case "booked": return Whim.ticketGreen
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
        .background(Color(uiColor: .systemBackground))
        .whimPage()
        .animation(.snappy(duration: 0.35), value: store.plan)
        .onAppear { store.start() }
        .onDisappear { store.stop() }
    }

    // MARK: - Shared pieces

    private func header(_ plan: PlanState, votes: Int) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            WhimHeader(context: "Plan", chipText: statusLabel, chipTint: statusTint)
            Text(plan.title.isEmpty ? "No plan yet" : plan.title)
                .font(Whim.display(26))
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(alignment: .firstTextBaseline, spacing: 18) {
                HeroStat(value: "\(votes)", label: votes == 1 ? "vote" : "votes")
                HeroStat(value: "\(plan.options.count)", label: plan.options.count == 1 ? "option" : "options", tint: .secondary)
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
                in: Rectangle()
            )
    }

    // MARK: - Transcript bubble: fixed, no scrolling, essentials only.

    private func compact(_ plan: PlanState) -> some View {
        let votes = plan.counts.values.reduce(0, +)
        return VStack(alignment: .leading, spacing: 10) {
            header(plan, votes: votes)
            if !plan.options.isEmpty {
                TicketRule()
                ForEach(plan.options.prefix(2)) { option in
                    HStack(spacing: 8) {
                        Image(systemName: plan.chosenOptionId == option.id ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(plan.chosenOptionId == option.id ? .green : Color(uiColor: .tertiaryLabel))
                            .font(.body)
                        Text(option.title)
                        .font(Whim.mono(14).weight(.medium))
                            .lineLimit(1)
                        Spacer(minLength: 6)
                        voteBadge(plan.counts[option.id] ?? 0)
                    }
                }
                HStack {
                    if plan.options.count > 2 {
                        Text("+\(plan.options.count - 2) more")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if plan.status == "voting" {
                        Label("Tap to vote", systemImage: "hand.tap")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Color.accentColor)
                    }
                }
            }
        }
        .padding(14)
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
                    TicketRule()
                    VStack(spacing: 0) {
                        ForEach(plan.options) { option in
                            optionRow(option, plan: plan, open: open)
                        }
                    }
                }
                if open {
                    Text("Tap an option to vote. Everyone in the chat sees the tally live.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let note = plan.bookingNote, !note.isEmpty {
                    TicketRule()
                    Label(note, systemImage: plan.status == "booked" ? "checkmark.seal.fill" : "info.circle")
                        .font(.subheadline)
                        .foregroundStyle(plan.status == "booked" ? .green : .secondary)
                }
                TicketRule()
                GameComposerView(base: store.base, chat: store.chat)
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
            .padding(.vertical, 11)
            .padding(.horizontal, 2)
            .background(mine ? Whim.ticketInk.opacity(0.07) : Color.clear)
            .overlay(alignment: .bottom) { Rectangle().fill(Whim.rule).frame(height: 1) }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!open)
    }
}
