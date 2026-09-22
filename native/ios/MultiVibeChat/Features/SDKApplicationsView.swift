import SwiftUI
import MultiVibeSDK
import MultiVibeChatUI

@MainActor enum SDKAccountClient {
    static func make() -> MultiVibeClient {
        let expectedAccount = ConversationManager.shared.session?.accountId
        return MultiVibeClient(configuration: MultiVibeConfiguration(clientID:"multivibe-ios",redirectURI:URL(string:"https://auth.multivibe.cloud/oauth/callback/ios")!),mode:.accountOwner,tokenProvider:{
            let session = try await ConversationManager.shared.validSession()
            guard session.accountId == expectedAccount else {throw MultiVibeError.authenticationRequired}
            return session.accessToken
        })
    }
}

struct SDKApplicationsView: View {
    @State private var client = SDKAccountClient.make()
    @State private var error:String?
    @State private var connections:[Connection] = []
    @State private var revokeTarget:Connection?
    private struct Connection:Decodable,Identifiable {let id:String;let name:String}
    private struct Connections:Decodable {let data:[Connection]}
    private struct Empty:Decodable {}
    var body:some View {
        List {
            if let error {Text(error).foregroundStyle(.red)}
            ForEach(Array(Dictionary(grouping:client.conversations,by: \.appId).keys).sorted(),id:\.self) {appID in
                let conversations = client.conversations.filter {$0.appId == appID}
                DisclosureGroup(conversations.first?.appName ?? appID) {
                    ForEach(conversations) {conversation in
                        NavigationLink(conversation.title) {MultiVibeChatView(client:client,conversation:conversation).navigationTitle(conversation.title)}
                            .swipeActions {Button("Supprimer",role:.destructive) {Task {do {try await client.delete(conversation)} catch {self.error = error.localizedDescription}}}}
                    }
                }
            }
            Section("Applications autorisées") {
                ForEach(connections) {connection in HStack {Text(connection.name);Spacer();Button("Révoquer",role:.destructive) {revokeTarget = connection}}}
            }
        }.navigationTitle("Applications")
        .task {await reload()}
        .refreshable {await reload()}
        .confirmationDialog("Révoquer cette application ?",isPresented:Binding(get:{revokeTarget != nil},set:{if !$0 {revokeTarget = nil}}),titleVisibility:.visible) {
            if let connection = revokeTarget {Button("Révoquer",role:.destructive) {Task {do {let _:Empty = try await client.accountRequest("/native/v1/sdk/connections/\(connection.id)/revoke",body:Data("{}".utf8),as:Empty.self);await reload()} catch {self.error = error.localizedDescription}}}}
        } message: {Text("L’application perdra son accès. Vos conversations seront conservées.")}
    }
    private func reload() async {
        do {try await client.connect(); connections = try await client.accountRequest("/native/v1/sdk/connections",as:Connections.self).data;error = nil} catch {self.error = error.localizedDescription}
    }
}

struct SDKAuthorizationRequest:Identifiable {
    let id = UUID();let query:String
    init?(url:URL) {
        guard let c = URLComponents(url:url,resolvingAgainstBaseURL:false),c.scheme == "https",c.host == "app.multivibe.cloud",c.port == nil,c.user == nil,c.password == nil,c.path == "/sdk/authorize",c.fragment == nil,let query = c.percentEncodedQuery,query.utf8.count <= 8192 else {return nil}
        self.query = query
    }
}
struct SDKConsentView:View {
    let request:SDKAuthorizationRequest
    @Environment(ConversationManager.self) private var manager
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var client = SDKAccountClient.make()
    @State private var info:Info?
    @State private var project = ""
    @State private var error:String?
    @State private var busy = false
    @State private var signingIn = false
    private struct Info:Decodable {
        struct Application:Decodable {let id:String;let name:String;let website:String?}
        struct Project:Decodable,Identifiable {let id:String;let name:String}
        let app:Application;let scopes:[String];let projects:[Project]
    }
    private struct Redirect:Decodable {let redirect:String}
    var body:some View {
        NavigationStack {
            Form {
                if manager.session == nil {
                    Text("Connectez votre compte MultiVibe pour autoriser cette application.")
                    Button("Se connecter") {signingIn = true}
                } else if let info {
                    Section {Text(info.app.name).font(.title2);if let website = info.app.website {Text(website).font(.caption)}}
                    Section("Autorisation") {
                        Text("Cette application pourra utiliser vos modèles et vos crédits, et synchroniser ses propres conversations avec MultiVibe.")
                        Text("Elle n’aura pas accès à vos autres conversations ni à votre mémoire personnelle.")
                        Text("Le contexte et les résultats d’outils partagés avec le modèle seront enregistrés dans ces conversations.")
                    }
                    if !info.projects.isEmpty {Picker("Projet de facturation",selection:$project) {ForEach(info.projects) {Text($0.name).tag($0.id)}}}
                    Button("Autoriser") {decide(true)}.disabled(busy)
                    Button("Refuser",role:.destructive) {decide(false)}.disabled(busy)
                } else {ProgressView()}
                if let error {Text(error).foregroundStyle(.red)}
            }.navigationTitle("Connexion MultiVibe")
            .toolbar {Button("Fermer") {dismiss()}}
            .sheet(isPresented:$signingIn) {AuthenticationView().environment(manager)}
            .onChange(of:manager.session?.accountId) {_,account in if account != nil {signingIn = false}}
            .task(id:manager.session?.accountId) {
                guard manager.session != nil else {return}
                client = SDKAccountClient.make()
                do {info = try await client.accountRequest("/native/v1/sdk/authorize?" + request.query,as:Info.self);project = info?.projects.first?.id ?? ""} catch {self.error = error.localizedDescription}
            }
        }
    }
    private func decide(_ allow:Bool) {
        busy = true
        Task {
            defer {busy = false}
            do {
                var fields:[String:JSONValue] = ["query":.string(request.query),"allow":.bool(allow)]
                if !project.isEmpty {fields["projectId"] = .string(project)}
                let result = try await client.accountRequest("/native/v1/sdk/authorize",body:JSONEncoder().encode(fields),as:Redirect.self)
                guard let url = URL(string:result.redirect),url.scheme == "https" else {throw MultiVibeError.invalidCallback}
                openURL(url);dismiss()
            } catch {self.error = error.localizedDescription}
        }
    }
}
