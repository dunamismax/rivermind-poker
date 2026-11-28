#if DEBUG
    import RiverMindKit
    import SwiftUI

    /// The app's `/style` (P5D.5), in debug builds only: every component of the kit in its
    /// states, as `KitGallery` lists them and the snapshot tests record them, then the native
    /// controls the app uses with the site's look, live. Open it from the lobby's toolbar, or
    /// launch with `-gallery`.
    struct GalleryView: View {
        @State private var text = ""
        @State private var amount = 120.0
        @State private var sound = true
        @State private var seats = 6
        @State private var choice = 1

        var body: some View {
            List {
                ForEach(KitGallery.sections, id: \.self) { section in
                    Section(section) {
                        ForEach(KitGallery.items.filter { $0.section == section }) { item in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(item.title)
                                    .font(.system(size: Metrics.textS))
                                    .foregroundStyle(Palette.mist.color)
                                item.view
                                    .clipShape(.rect(cornerRadius: Metrics.radiusS))
                                    .frame(maxWidth: .infinity)
                            }
                            .accessibilityElement(children: .contain)
                            .accessibilityIdentifier("gallery.\(item.id)")
                            .listRowBackground(Palette.night.color)
                        }
                    }
                }
                Section {
                    Text("\(KitGallery.items.count) components")
                        .font(.system(size: Metrics.textS))
                        .foregroundStyle(Palette.haze.color)
                        .accessibilityIdentifier("gallery.count")
                        .listRowBackground(Palette.night.color)
                }
                Section("Live") {
                    // The kit's buttons, pressable; a choice that turns gold.
                    HStack(spacing: 8) {
                        ForEach(0..<3) { index in
                            Button(["2 seats", "6 seats", "9 seats"][index]) { choice = index }
                                .buttonStyle(.kit(chosen: choice == index))
                        }
                    }
                    HStack(spacing: 8) {
                        Button("Fold") {}.buttonStyle(.kit(.red, wide: true))
                        Button("Call 40") {}.buttonStyle(.kit(.blue, wide: true))
                        Button("Raise") {}.buttonStyle(.kit(.gold, wide: true))
                    }
                    Button("Not now") {}.buttonStyle(.kit()).disabled(true)
                    TextField("Buy-in", text: $text)
                        .textFieldStyle(KitFieldStyle())
                        .keyboardType(.numberPad)
                    // Native controls, in the site's gold.
                    VStack(alignment: .leading) {
                        Text("Raise to \(Int(amount))").font(.system(size: Metrics.textS))
                        Slider(value: $amount, in: 40...1000, step: 10)
                    }
                    Toggle("Sounds", isOn: $sound)
                    Picker("Seats", selection: $seats) {
                        ForEach([2, 6, 9], id: \.self) { Text("\($0)").tag($0) }
                    }
                    .pickerStyle(.segmented)
                    Button("Glass") {}.buttonStyle(.glass)
                    Button("Prominent glass") {}.buttonStyle(.glassProminent)
                }
                .listRowBackground(Palette.deepSlate.color)
            }
            .scrollContentBackground(.hidden)
            .navigationTitle("Gallery")
            .toolbarTitleDisplayMode(.inline)
            .kitPage()
            .accessibilityIdentifier("gallery")
        }
    }
#endif
