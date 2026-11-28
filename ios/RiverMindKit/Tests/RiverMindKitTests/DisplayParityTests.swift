import Foundation
import Testing
@testable import RiverMindKit

/// What the page computes only to show, written from the TypeScript by `pnpm ios:fixtures`
/// (web/src/lib/server/api/ios-display.spec.ts): the Swift ports must give exactly the same.
struct DisplayFixture: Decodable {
    struct HandCase: Decodable {
        let cards: [Card]
        let `class`: String
        let name: String
        let value: Int?
    }

    struct BetCase: Decodable {
        struct Fraction: Decodable {
            let fraction: Double
            let to: Double
        }
        struct Raise: Decodable {
            let amount: Int
            let label: String
        }
        struct Clamp: Decodable {
            let amount: Double
            let to: Int
        }
        let legal: Legal
        let currentBet: Int
        let pot: Int
        let presets: [BetPreset]
        let call: String
        let fractions: [Fraction]
        let raises: [Raise]
        let clamps: [Clamp]
    }

    struct EventCase: Decodable {
        let event: TableEvent
        let names: [String?]
        let text: String?
    }

    struct PotCase: Decodable {
        let result: HandResult
        let names: [String?]
        let lines: [String]
    }

    struct SeatCase: Decodable {
        let info: SeatInfo
        let status: String
        let label: String
        let mine: String
        let avatar: String
    }

    struct FaceCases: Decodable {
        struct Rate: Decodable {
            let value: Double
            let text: String
        }
        struct ChampionCase: Decodable {
            let champion: BotChampion
            let text: String
        }
        struct Note: Decodable {
            let seats: [Int]
            let text: String
        }
        struct Label: Decodable {
            let kind: String?
            let text: String
        }
        struct Pod: Decodable {
            let name: String
            let parts: [NamePart]
        }
        struct Person: Decodable {
            let name: String
            let avatar: Int
        }
        struct Chip: Decodable {
            let amount: Int
            let big: Int
            let chip: String
        }
        let winRates: [Rate]
        let championLines: [ChampionCase]
        let seatsNotes: [Note]
        let botLabels: [Label]
        let podNames: [Pod]
        let personAvatars: [Person]
        let chips: [Chip]
    }

    struct ReplayCase: Decodable {
        let detail: HandDetail
        let steps: [ReplayStep]
        let stages: [String]
    }

    struct ActionCase: Decodable {
        let action: ActionRecord
        let text: String
    }

    struct KeyCase: Decodable {
        let key: String
        let index: Int
        let count: Int
        let to: Int?
    }

    struct CardCase: Decodable {
        let card: Card
        let name: String
        let short: String
    }

    struct SafetyCases: Decodable {
        struct Relation: Decodable {
            let kind: RelationKind?
            let text: String
        }
        let reactions: [Safety.ReactionWords]
        let reportReasons: [Safety.ReasonWords]
        let voiceReportNote: String
        let relations: [Relation]
    }

    struct LobbyCases: Decodable {
        struct Bot: Decodable {
            let bot: BotOption
            let note: String
            let trained: String
        }
        struct ForSeats: Decodable {
            let seats: Int
            let kinds: [String]
        }
        struct PracticeNote: Decodable {
            let stack: Int?
            let text: String
        }
        struct BuyIns: Decodable {
            let big: Int
            let balance: Int?
            let affordable: [Int]
            let labels: [String]
        }
        /// `TableChoice` as the TypeScript writes it.
        struct Choice: Decodable {
            let kind: String
            let note: String?
            let afford: Bool?

            var swift: LobbyWords.Choice? {
                switch kind {
                case "seated": .seated
                case "ready": note.map { .ready(note: $0) }
                case "held": note.map { .held(note: $0) }
                case "waiting": note.map { .waiting(note: $0) }
                case "sit": afford.map { .sit(afford: $0) }
                case "waitlist": afford.map { .waitlist(afford: $0) }
                default: nil
                }
            }
        }
        struct BalanceChoice: Decodable {
            let balance: Int?
            let choice: Choice
        }
        struct Table: Decodable {
            let table: TableSummary
            let seats: String
            let pips: [LobbyWords.Pip]
            let detail: String
            let room: Bool
            let invite: String
            let choices: [BalanceChoice]
        }
        struct Link: Decodable {
            let origin: String
            let code: String
            let link: String
        }
        let bots: [Bot]
        let practiceBots: [String]
        let botsFor: [ForSeats]
        let practiceNotes: [PracticeNote]
        let walletHint: String
        let buyIns: [BuyIns]
        let tables: [Table]
        let inviteLinks: [Link]
    }
    let hands: [HandCase]
    let bets: [BetCase]
    let events: [EventCase]
    let pots: [PotCase]
    let seats: [SeatCase]
    let faces: FaceCases
    let replays: [ReplayCase]
    let actions: [ActionCase]
    let stepKeys: [KeyCase]
    let cards: [CardCase]
    let safety: SafetyCases
    let lobby: LobbyCases
    let layout: LayoutCases
    let table: TableCases
    let content: ContentCases

    struct ContentCases: Decodable {
        struct Measured: Decodable {
            let seats: Int
            let text: String
        }
        let tableRules: [ContentWords.Rule]
        let botRules: [String]
        let conduct: String
        let botsLead: String
        let simpleBots: [ContentWords.SimpleBot]
        let botCaveats: [String]
        let measured: [Measured]
        let repository: String
    }

    struct LayoutCases: Decodable {
        struct BetSpot: Decodable {
            let left: Double
            let top: Double
            let shift: String?
            let aside: String?
            let beside: TableLayout.Side?
        }
        struct Place: Decodable {
            let spot: TableLayout.Spot
            let side: TableLayout.Side
            let bet: BetSpot
        }
        struct ShapeCase: Decodable {
            let shape: TableLayout.Shape
            let places: [Place]
        }
        struct PlaceOf: Decodable {
            let seat: Int
            let anchor: Int?
            let place: Int
        }
        struct Table: Decodable {
            let count: Int
            let shapes: [ShapeCase]
            let placeOf: [PlaceOf]
        }
        struct Clock: Decodable {
            struct Span: Decodable {
                let started: Double
                let deadline: Double
                let final: Double
            }
            let turn: Span
            let now: Double
            let left: TableLayout.ClockLeft
        }
        let tables: [Table]
        let clocks: [Clock]
    }

    struct TableCases: Decodable {
        struct JoinLine: Decodable {
            let holdLeft: Int?
            let short: Bool
            let text: String
        }
        struct Case: Decodable {
            let view: TableView
            let names: [String]
            let inHand: Bool
            let myTurn: Bool
            let waitingFor: String?
            let rebuyRoom: Int
            let busted: Bool
            let dealtIn: Bool
            let reviewable: Bool
            let room: Bool
            let empty: [TableWords.EmptySeat]
            let handLine: String
            let dockLine: String
            let joinLines: [JoinLine]
            let buyInHint: String
            let refill: String
            let pendingRebuy: String?
        }
        struct Entry: Decodable {
            let event: TableEvent
            let who: String?
        }
        struct Log: Decodable {
            let log: [Entry]
            let view: TableView
            let lines: [TableWords.LogLine]
        }
        struct NoHand: Decodable {
            let handNo: Int?
            let text: String
        }
        let cases: [Case]
        let logs: [Log]
        let emptyText: [String: String]
        let noHand: [NoHand]
    }

    static let shared: DisplayFixture = {
        let url = repository.appending(path: "ios/RiverMindKit/Fixtures/display.json")
        // swiftlint:disable:next force_try
        return try! JSONDecoder().decode(DisplayFixture.self, from: Data(contentsOf: url))
    }()
}

private func nameOf(_ names: [String?]) -> (Int) -> String {
    { seat in (seat < names.count ? names[seat] : nil) ?? "Seat \(seat + 1)" }
}

@Suite struct DisplayParityTests {
    let fixture = DisplayFixture.shared

    @Test func handNamesMatchThePage() {
        #expect(fixture.hands.count > 500)
        #expect(Set(fixture.hands.map(\.class)) == Set(HandClass.allCases.map(\.rawValue)))
        for case_ in fixture.hands {
            let named = HandName.name(case_.cards)
            #expect(named.handClass.rawValue == case_.class, "\(case_.cards)")
            #expect(named.name == case_.name, "\(case_.cards)")
        }
    }

    @Test func theEvaluatorRanksAsTheEngineDoes() {
        for case_ in fixture.hands {
            let value = Evaluator.evaluate(case_.cards)
            #expect(value == case_.value, "\(case_.cards)")
            // A hand's name names the class the engine ranks it in.
            if let value {
                #expect(HandClass.allCases[Evaluator.rankClass(value) - 1].rawValue == case_.class)
            }
        }
        #expect(Evaluator.combinations(Array(0..<7), 5).count == 21)
    }

    @Test func betSizesAndLabelsMatchThePage() {
        #expect(fixture.bets.count >= 100)
        #expect(fixture.bets.contains { $0.legal.raiseKind == nil })
        #expect(fixture.bets.contains { $0.legal.raiseKind == .bet })
        #expect(fixture.bets.contains { $0.legal.raiseKind == .raise })
        for case_ in fixture.bets {
            let legal = case_.legal
            #expect(Bet.presets(legal, currentBet: case_.currentBet, pot: case_.pot) == case_.presets)
            #expect(Bet.callLabel(legal) == case_.call)
            for fraction in case_.fractions {
                #expect(
                    Bet.potFraction(fraction.fraction, legal, currentBet: case_.currentBet, pot: case_.pot)
                        == fraction.to)
            }
            for raise in case_.raises { #expect(Bet.raiseLabel(legal, raise.amount) == raise.label) }
            for clamp in case_.clamps { #expect(Bet.clamp(clamp.amount, legal) == clamp.to, "\(clamp.amount)") }
            #expect(Bet.clamp(.nan, legal) == legal.minTo)
            #expect(Bet.clamp(.infinity, legal) == legal.minTo)
        }
    }

    @Test func theHandLogMatchesThePage() {
        let kinds = Set(fixture.events.map(\.event.kind))
        #expect(kinds.isSuperset(of: EventKind.known))
        for case_ in fixture.events {
            #expect(Bet.describe(case_.event, nameOf: nameOf(case_.names)) == case_.text, "\(case_.event)")
        }
    }

    @Test func potLinesMatchThePage() {
        #expect(fixture.pots.contains { $0.result.pots.count > 2 })
        #expect(fixture.pots.contains { $0.result.pots.contains { $0.winners.count > 1 } })
        for case_ in fixture.pots {
            #expect(Bet.potLines(case_.result, nameOf: nameOf(case_.names)) == case_.lines)
        }
    }

    @Test func seatWordsMatchThePage() {
        for case_ in fixture.seats {
            #expect(Faces.status(case_.info) == case_.status)
            #expect(Faces.label(case_.info, me: false) == case_.label)
            #expect(Faces.label(case_.info, me: true) == case_.mine)
            #expect(Faces.avatar(case_.info) == case_.avatar)
        }
    }

    @Test func facesMatchThePage() {
        let faces = fixture.faces
        for rate in faces.winRates { #expect(Faces.winRate(rate.value) == rate.text, "\(rate.value)") }
        for line in faces.championLines { #expect(Faces.championLine(line.champion) == line.text) }
        for note in faces.seatsNotes { #expect(Faces.seatsNote(note.seats) == note.text) }
        for label in faces.botLabels { #expect(Faces.botLabel(label.kind) == label.text) }
        for pod in faces.podNames { #expect(Faces.podName(pod.name) == pod.parts, "\(pod.name)") }
        for person in faces.personAvatars { #expect(Faces.personAvatar(person.name) == person.avatar) }
        for chip in faces.chips { #expect(Faces.chip(chip.amount, bigBlind: chip.big) == chip.chip) }
    }

    @Test func replaysMatchThePage() {
        let kinds = Set(fixture.replays.flatMap { $0.steps.map(\.kind) })
        #expect(kinds == [.posts, .action, .tabled, .street, .showdown, .result])
        for case_ in fixture.replays {
            let steps = Replay.steps(case_.detail)
            #expect(steps.count == case_.steps.count, "hand \(case_.detail.hand.handID)")
            for (index, (mine, page)) in zip(steps, case_.steps).enumerated() {
                #expect(mine == page, "hand \(case_.detail.hand.handID) step \(index)")
            }
            #expect(steps.map(Replay.stage) == case_.stages)
        }
        for case_ in fixture.actions {
            #expect(Replay.describe(case_.action, who: "Ann") == case_.text)
        }
        for case_ in fixture.stepKeys {
            #expect(Replay.step(forKey: case_.key, index: case_.index, count: case_.count) == case_.to)
        }
    }

    @Test func cardsAndSafetyWordsMatchThePage() {
        #expect(fixture.cards.count == 52)
        for case_ in fixture.cards {
            #expect(Wording.cardName(case_.card) == case_.name)
            #expect(Wording.shortCard(case_.card) == case_.short)
        }
        #expect(Safety.reactions == fixture.safety.reactions)
        #expect(Safety.reportReasons == fixture.safety.reportReasons)
        #expect(Safety.voiceReportNote == fixture.safety.voiceReportNote)
        for relation in fixture.safety.relations {
            #expect(Safety.relationText(relation.kind) == relation.text)
        }
    }

    /// The page renders `undefined` where a newer server leaves a field out or sends a
    /// kind this build does not know; the app says something plain instead.
    @Test func theLobbysWordsMatchThePage() throws {
        let lobby = fixture.lobby
        let bots = lobby.bots.map(\.bot)
        for case_ in lobby.bots {
            #expect(LobbyWords.botNote(case_.bot) == case_.note, "\(case_.bot.kind)")
            #expect(LobbyWords.trainedNote(case_.bot.kind) == case_.trained)
        }
        #expect(LobbyWords.practiceBots(bots).map(\.kind) == lobby.practiceBots)
        for case_ in lobby.botsFor {
            #expect(LobbyWords.bots(bots, for: case_.seats).map(\.kind) == case_.kinds)
        }
        for case_ in lobby.practiceNotes {
            #expect(LobbyWords.practiceNote(stack: case_.stack) == case_.text)
        }
        #expect(LobbyWords.walletHint == lobby.walletHint)
        for case_ in lobby.buyIns {
            #expect(LobbyWords.affordableBuyIns(bigBlind: case_.big, balance: case_.balance) == case_.affordable)
            #expect(LobbyWords.buyIns.map { LobbyWords.buyInLabel($0, bigBlind: case_.big) } == case_.labels)
        }
        #expect(lobby.tables.count >= 50)
        let kinds = Set(lobby.tables.flatMap { $0.choices.map(\.choice.kind) })
        #expect(kinds == ["seated", "ready", "held", "waiting", "sit", "waitlist"])
        for case_ in lobby.tables {
            let t = case_.table
            #expect(LobbyWords.seatsText(t) == case_.seats, "\(t.tableID)")
            #expect(LobbyWords.pips(t) == case_.pips, "\(t.tableID)")
            #expect(LobbyWords.tableDetail(t) == case_.detail)
            #expect(LobbyWords.hasRoom(t) == case_.room)
            #expect(LobbyWords.inviteLine(t) == case_.invite)
            for choice in case_.choices {
                let expected = try #require(choice.choice.swift)
                #expect(LobbyWords.choice(t, balance: choice.balance) == expected, "\(t.tableID) \(String(describing: choice.balance))")
            }
        }
        for case_ in lobby.inviteLinks {
            #expect(LobbyWords.inviteLink(origin: case_.origin, code: case_.code) == case_.link)
            // A link the app made reads back as its code.
            #expect(LobbyWords.inviteCode(in: case_.link) == case_.code)
        }
    }

    @Test func theTableLayoutMatchesThePage() {
        #expect(fixture.layout.tables.map(\.count) == Array(2...9))
        for table in fixture.layout.tables {
            for shape in table.shapes {
                let spots = TableLayout.places(table.count, shape.shape)
                #expect(spots == shape.places.map(\.spot), "\(table.count) \(shape.shape)")
                for (place, expected) in shape.places.enumerated() {
                    let spot = spots[place]
                    #expect(TableLayout.sideOf(spot, place: place) == expected.side)
                    let bet = TableLayout.betSpot(spot, place: place, shape: shape.shape)
                    let what = "\(table.count) \(shape.shape) place \(place)"
                    #expect(bet.left == expected.bet.left, "\(what)")
                    #expect(bet.top == expected.bet.top, "\(what)")
                    #expect(bet.shift?.css == expected.bet.shift, "\(what)")
                    #expect(bet.aside?.css == expected.bet.aside, "\(what)")
                    #expect(bet.beside == expected.bet.beside, "\(what)")
                }
            }
            for case_ in table.placeOf {
                #expect(TableLayout.placeOf(case_.seat, anchor: case_.anchor, count: table.count) == case_.place)
            }
        }
        #expect(TableLayout.places(10).isEmpty)
        for clock in fixture.layout.clocks {
            let left = TableLayout.clockLeft(
                started: clock.turn.started, deadline: clock.turn.deadline, final: clock.turn.final, now: clock.now)
            #expect(left == clock.left, "\(clock.turn) at \(clock.now)")
        }
    }

    @Test func theTablesWordsMatchThePage() {
        let table = fixture.table
        #expect(table.cases.count > 200)
        // Every line the dock and the join panel can show comes up.
        #expect(Set(table.cases.map { $0.dockLine.prefix(12) }).count >= 5)
        #expect(table.cases.contains(where: \.myTurn) && table.cases.contains(where: \.busted))
        for case_ in table.cases {
            let view = case_.view
            let what = "view seq \(view.seq)"
            #expect(view.seats.indices.map { TableWords.nameOf(view, $0) } == case_.names, "\(what)")
            #expect(TableWords.inHand(view) == case_.inHand, "\(what)")
            #expect(TableWords.myTurn(view) == case_.myTurn, "\(what)")
            #expect(TableWords.waitingFor(view) == case_.waitingFor, "\(what)")
            #expect(TableWords.rebuyRoom(view) == case_.rebuyRoom, "\(what)")
            #expect(TableWords.busted(view) == case_.busted, "\(what)")
            #expect(TableWords.dealtIn(view) == case_.dealtIn, "\(what)")
            #expect(TableWords.reviewable(view) == case_.reviewable, "\(what)")
            #expect(TableWords.hasSeatRoom(view) == case_.room, "\(what)")
            #expect(view.seats.indices.map { TableWords.emptySeat(view, $0) } == case_.empty, "\(what)")
            #expect(TableWords.handLine(view) == case_.handLine, "\(what)")
            #expect(TableWords.dockLine(view) == case_.dockLine, "\(what)")
            for line in case_.joinLines {
                #expect(TableWords.joinLine(view, holdLeft: line.holdLeft, short: line.short) == line.text, "\(what)")
            }
            #expect(TableWords.buyInHint(view) == case_.buyInHint)
            #expect(TableWords.refillText(view) == case_.refill)
            #expect(TableWords.pendingRebuyText(view) == case_.pendingRebuy, "\(what)")
        }
        #expect(table.logs.count > 10)
        for log in table.logs {
            let entries = log.log.map { LoggedEvent(event: $0.event, who: $0.who) }
            #expect(TableWords.logLines(entries, log.view) == log.lines, "log at view \(log.view.seq)")
        }
        for kind in TableWords.EmptySeat.allCases {
            #expect(table.emptyText[kind.rawValue] == kind.text)
        }
        for case_ in table.noHand {
            #expect(TableWords.noHandText(case_.handNo) == case_.text)
        }
    }

    @Test func theContentPagesWordsMatchThePage() {
        let content = fixture.content
        #expect(ContentWords.tableRules == content.tableRules)
        #expect(ContentWords.botRules == content.botRules)
        #expect(ContentWords.conduct == content.conduct)
        #expect(ContentWords.botsLead == content.botsLead)
        #expect(ContentWords.simpleBots == content.simpleBots)
        #expect(ContentWords.botCaveats == content.botCaveats)
        for case_ in content.measured {
            #expect(ContentWords.measuredText(seats: case_.seats) == case_.text)
        }
        #expect(ContentWords.repository == content.repository)
        #expect(
            ContentWords.reportURL("docs/evaluations/hu-m1-s0-1024m-served.md")?.absoluteString
                == "\(content.repository)/docs/evaluations/hu-m1-s0-1024m-served.md")
        #expect(ContentWords.reportURL("../secret") == nil)
    }

    @Test func aNewerServerReadsPlainly() throws {
        let event = try JSONDecoder().decode(
            TableEvent.self,
            from: Data(#"{"seq":1,"kind":"action","seat":0,"action":"straddle","amount":200}"#.utf8))
        #expect(Bet.describe(event, nameOf: { _ in "Ann" }) == "Ann straddle 200")
        let unknown = try JSONDecoder().decode(TableEvent.self, from: Data(#"{"seq":2,"kind":"confetti"}"#.utf8))
        #expect(Bet.describe(unknown, nameOf: { _ in "Ann" }) == nil)
        #expect(Faces.botLabel("deep_blue") == "deep blue")
        #expect(Wording.shortCard(Card(rank: 14, suit: Suit(rawValue: "stars"))) == "Astars")
    }
}
