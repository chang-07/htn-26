import SwiftUI

// Native versions of the two token'd forms. They speak the existing endpoints:
// GET ?json=1 for prefill, form-encoded POST ?json=1 to save. The token in the
// card's URL is the credential, exactly as on the web pages.

private func formEncode(_ fields: [(String, String)]) -> Data {
    fields.map { k, v in
        let esc = v.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        return "\(k)=\(esc)"
    }.joined(separator: "&").data(using: .utf8) ?? Data()
}

private struct FieldRow: View {
    let label: String
    let hint: String
    @Binding var value: String
    var long = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            if long {
                TextField(hint, text: $value, axis: .vertical)
                    .lineLimit(2...4)
                    .textFieldStyle(.plain)
            } else {
                TextField(hint, text: $value).textFieldStyle(.plain)
            }
            TicketRule()
        }
    }
}

private struct CompactPrompt: View {
    let icon: String
    let title: String
    let line: String
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: icon)
                .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            Text(line).font(.title3.weight(.bold))
            Label("Tap to open", systemImage: "hand.tap")
                .font(.footnote.weight(.semibold)).foregroundStyle(Color.accentColor)
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - Profile

struct ProfileFormView: View {
    let formURL: URL // /p/<token>
    @ObservedObject var presentation: PresentationInfo

    @State private var name = ""; @State private var area = ""; @State private var diet = ""
    @State private var budget = ""; @State private var interests = ""; @State private var about = ""
    @State private var links = ""; @State private var matchOptIn = false
    @State private var loaded = false
    @State private var saving = false
    @State private var saved = false

    var body: some View {
        Group {
            if presentation.isTranscript {
                CompactPrompt(icon: "person.crop.circle", title: "Profile", line: saved ? "Saved" : "Set up your profile")
            } else if saved {
                doneView
            } else {
                form
            }
        }
        .background(Color(uiColor: .systemBackground))
        .whimPage()
        .task { await load() }
    }

    private var doneView: some View {
        VStack(spacing: 10) {
            Image(systemName: "checkmark.seal.fill").font(.largeTitle).foregroundStyle(.green)
            Text("Got it\(name.isEmpty ? "" : ", \(name)")").font(.title3.weight(.bold))
            Text("The planner uses this in every chat you're in.")
                .font(.footnote).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var form: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Label("Your profile", systemImage: "person.crop.circle")
                    .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Text("So the plans fit you").font(.title3.weight(.bold))
                Text("Fill in what you like, skip the rest. Only you have this link.")
                    .font(.footnote).foregroundStyle(.secondary)

                FieldRow(label: "What you go by", hint: "Maya", value: $name)
                FieldRow(label: "Where you're based", hint: "Neighbourhood or city", value: $area)
                FieldRow(label: "Food rules", hint: "Vegetarian, halal, none…", value: $diet)
                FieldRow(label: "A normal night out costs", hint: "$20, $50, whatever it takes", value: $budget)
                FieldRow(label: "What you're into", hint: "Bouldering, ramen, film cameras", value: $interests, long: true)
                FieldRow(label: "Anything else worth knowing", hint: "Hate loud bars. Free most Fridays.", value: $about, long: true)
                FieldRow(label: "Links, if you want", hint: "@you on instagram — one per line", value: $links, long: true)

                Toggle(isOn: $matchOptIn) {
                    Text("Count me in for matching")
                        .font(.subheadline.weight(.medium))
                }
                .tint(.accentColor)

                Button {
                    Task { await save() }
                } label: {
                    Text(saving ? "Saving…" : "Save")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                }
                .buttonStyle(PillButtonStyle())
                .disabled(saving || !loaded)
            }
            .padding(16)
        }
    }

    private func jsonURL() -> URL {
        var comps = URLComponents(url: formURL, resolvingAgainstBaseURL: false)!
        var items = comps.queryItems ?? []
        items.append(URLQueryItem(name: "json", value: "1"))
        comps.queryItems = items
        return comps.url!
    }

    private func load() async {
        guard !loaded else { return }
        struct Prefill: Codable {
            let name, area, diet, budget, interests, about, links: String
            let matchOptIn: Bool
        }
        if let (data, _) = try? await URLSession.shared.data(from: jsonURL()),
           let p = try? JSONDecoder().decode(Prefill.self, from: data) {
            name = p.name; area = p.area; diet = p.diet; budget = p.budget
            interests = p.interests; about = p.about; links = p.links; matchOptIn = p.matchOptIn
        }
        loaded = true
    }

    private func save() async {
        saving = true
        defer { saving = false }
        var req = URLRequest(url: jsonURL())
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var fields: [(String, String)] = [
            ("name", name), ("area", area), ("diet", diet), ("budget", budget),
            ("interests", interests), ("about", about), ("links", links),
        ]
        if matchOptIn { fields.append(("matchOptIn", "on")) }
        req.httpBody = formEncode(fields)
        if let (data, _) = try? await URLSession.shared.data(for: req),
           let ok = try? JSONDecoder().decode([String: AnyCodableBool].self, from: data),
           ok["ok"]?.value == true {
            saved = true
        }
    }
}

/// Tolerates {"ok":true,"name":"…"} — only the bool matters.
struct AnyCodableBool: Codable {
    let value: Bool?
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        value = try? c.decode(Bool.self)
    }
    func encode(to encoder: Encoder) throws {}
}

// MARK: - Ship-to

struct ShipFormView: View {
    let formURL: URL // /p/<token>/ship[?chat=…]
    @ObservedObject var presentation: PresentationInfo

    @State private var name = ""; @State private var email = ""; @State private var line1 = ""
    @State private var line2 = ""; @State private var city = ""; @State private var region = ""
    @State private var postal = ""; @State private var country = ""
    @State private var problem: String?
    @State private var saving = false
    @State private var saved = false
    @State private var loaded = false

    var body: some View {
        Group {
            if presentation.isTranscript {
                CompactPrompt(icon: "shippingbox", title: "Delivery", line: saved ? "Saved" : "Where should it ship?")
            } else if saved {
                VStack(spacing: 10) {
                    Image(systemName: "checkmark.seal.fill").font(.largeTitle).foregroundStyle(.green)
                    Text("That's where it ships").font(.title3.weight(.bold))
                    Text("Back to the chat — the planner carries on from here.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                form
            }
        }
        .background(Color(uiColor: .systemBackground))
        .whimPage()
        .task { await load() }
    }

    private var form: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Label("Delivery", systemImage: "shippingbox")
                    .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Text("Where should it ship?").font(.title3.weight(.bold))
                Text("Asked once. Used only to fill a store's checkout when you offer to pay. No card details here, ever.")
                    .font(.footnote).foregroundStyle(.secondary)

                FieldRow(label: "Full name", hint: "As it should appear on the parcel", value: $name)
                FieldRow(label: "Email", hint: "The store sends the receipt here", value: $email)
                FieldRow(label: "Address", hint: "Street and number", value: $line1)
                FieldRow(label: "Apartment, unit", hint: "Optional", value: $line2)
                FieldRow(label: "City", hint: "", value: $city)
                HStack(spacing: 12) {
                    FieldRow(label: "State / province", hint: "ON, CA, NY", value: $region)
                    FieldRow(label: "Postal / ZIP", hint: "", value: $postal)
                    FieldRow(label: "Country", hint: "CA or US", value: $country)
                }

                if let problem {
                    Label(problem, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote).foregroundStyle(.red)
                }

                Button {
                    Task { await save() }
                } label: {
                    Text(saving ? "Saving…" : "Save")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                }
                .buttonStyle(PillButtonStyle())
                .disabled(saving)
            }
            .padding(16)
        }
    }

    private func jsonURL() -> URL {
        var comps = URLComponents(url: formURL, resolvingAgainstBaseURL: false)!
        var items = comps.queryItems ?? []
        items.append(URLQueryItem(name: "json", value: "1"))
        comps.queryItems = items
        return comps.url!
    }

    private func load() async {
        guard !loaded else { return }
        struct Wrap: Codable {
            struct Ship: Codable {
                let name, email, line1, city, region, postal, country: String
                let line2: String?
            }
            let shipTo: Ship?
        }
        if let (data, _) = try? await URLSession.shared.data(from: jsonURL()),
           let w = try? JSONDecoder().decode(Wrap.self, from: data), let s = w.shipTo {
            name = s.name; email = s.email; line1 = s.line1; line2 = s.line2 ?? ""
            city = s.city; region = s.region; postal = s.postal; country = s.country
        }
        loaded = true
    }

    private func save() async {
        saving = true
        defer { saving = false }
        var req = URLRequest(url: jsonURL())
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.httpBody = formEncode([
            ("name", name), ("email", email), ("line1", line1), ("line2", line2),
            ("city", city), ("region", region), ("postal", postal), ("country", country),
        ])
        struct Result: Codable { let ok: Bool; let problem: String? }
        if let (data, _) = try? await URLSession.shared.data(for: req),
           let r = try? JSONDecoder().decode(Result.self, from: data) {
            if r.ok { saved = true } else { problem = r.problem ?? "Something's missing." }
        } else {
            problem = "Couldn't save — try again."
        }
    }
}
