import SwiftUI
import MultiVibeSDK
import MultiVibeChatUI

actor ExampleItems {
    static let shared = ExampleItems()
    private let file = FileManager.default.urls(for:.documentDirectory,in:.userDomainMask)[0].appending(path:"sdk-example-items.json")
    func read() -> [String] {(try? JSONDecoder().decode([String].self,from:Data(contentsOf:file))) ?? []}
    func create(_ title:String) throws -> [String] {var items = read();items.append(title);try JSONEncoder().encode(items).write(to:file,options:.atomic);return items}
}
@main struct ExampleApp:App {
    @State private var client:MultiVibeClient?
    init() {
        let id = Bundle.main.object(forInfoDictionaryKey:"MultiVibeClientID") as? String ?? ""
        let host = Bundle.main.object(forInfoDictionaryKey:"MultiVibeCallbackHost") as? String ?? ""
        if UUID(uuidString:id) != nil, let callback = URL(string:"https://\(host)/multivibe/callback"), !host.contains("REPLACE") {
            _client = State(initialValue:MultiVibeClient(configuration:.init(clientID:id,redirectURI:callback),localProvider:AppleFoundationLocalProvider()))
        }
    }
    var body:some Scene {
        WindowGroup {
            NavigationStack {
                if let client {MultiVibeChatView(client:client,tools:Self.tools).navigationTitle(Bundle.main.object(forInfoDictionaryKey:"CFBundleDisplayName") as? String ?? "SDK")}
                else {ContentUnavailableView("Configurer l’exemple",systemImage:"key",description:Text("Enregistrez cette application dans le portail développeur, puis renseignez SDK_CLIENT_ID et SDK_CALLBACK_HOST dans ses Build Settings."))}
            }
        }
    }
    static let tools:[MultiVibeTool] = [
        MultiVibeTool(name:"read_items",description:"Lire les éléments de cette application",parameters:.object(["type":.string("object"),"properties":.object([:]),"additionalProperties":.bool(false)]),modifiesData:false) {_ in .array(await ExampleItems.shared.read().map(JSONValue.string))},
        MultiVibeTool(name:"create_item",description:"Créer un élément après confirmation",parameters:.object(["type":.string("object"),"properties":.object(["title":.object(["type":.string("string")])]),"required":.array([.string("title")]),"additionalProperties":.bool(false)]),modifiesData:true) {value in
            guard case .object(let fields) = value,case .string(let title) = fields["title"],!title.isEmpty,title.count <= 200 else {throw MultiVibeError.invalidArguments}
            return .array(try await ExampleItems.shared.create(title).map(JSONValue.string))
        }
    ]
}
