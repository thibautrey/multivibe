import SwiftUI
import MultiVibeSDK

@MainActor public struct MultiVibeChatView: View {
    private let client:MultiVibeClient
    private let tools:[MultiVibeTool]
    private let contextProvider:(any MultiVibeContextProvider)?
    @State private var conversation:MultiVibeConversation?
    @State private var text = ""
    @State private var error:String?
    @State private var task:Task<Void,Never>?
    @State private var pending:MultiVibeToolCall?
    @State private var confirmation:CheckedContinuation<Bool,Never>?
    #if canImport(UIKit)
    @State private var authentication:MultiVibeAuthenticationPresenter?
    #endif
    public init(client:MultiVibeClient,conversation:MultiVibeConversation? = nil,tools:[MultiVibeTool] = [],contextProvider:(any MultiVibeContextProvider)? = nil,initialPrompt:String = "") {
        self.client = client; self.tools = tools; self.contextProvider = contextProvider; _conversation = State(initialValue:conversation); _text = State(initialValue:initialPrompt)
    }
    public var body: some View {
        VStack(spacing:0) {
            if client.mode == .accountOwner, let conversation {
                HStack {Text(conversation.appName).bold(); Spacer(); if let raw = conversation.appURL, let url = URL(string:raw), url.scheme == "https" {Link("Ouvrir dans l’application",destination:originURL(url,conversationID:conversation.id))}}.padding()
                Text("Les outils et les données actualisées de cette application ne sont pas disponibles ici.").font(.caption).foregroundStyle(.secondary).padding(.horizontal)
            }
            ScrollView {
                LazyVStack(alignment:.leading,spacing:16) {
                    ForEach(conversation?.messages ?? []) { message in
                        VStack(alignment:.leading,spacing:6) {
                            Text(message.role == "user" ? "Vous" : message.role == "tool" ? "Résultat de l’application" : "MultiVibe").font(.caption).foregroundStyle(.secondary)
                            Text(.init(message.content)).textSelection(.enabled)
                            ForEach(message.toolCalls ?? []) {call in Text("\(call.name) · \(call.arguments)").font(.caption).textSelection(.enabled)}
                            if let status = message.status, status != "completed" {Text(status).font(.caption).foregroundStyle(.secondary)}
                        }.frame(maxWidth:.infinity,alignment:message.role == "user" ? .trailing : .leading)
                    }
                }.padding()
            }
            if let error {Text(error).font(.caption).foregroundStyle(.red).padding()}
            if !tools.isEmpty, client.models.first(where:{$0.id == conversation?.model})?.supportsTools != true {
                Text("Les outils de cette application ne sont pas disponibles avec ce modèle.").font(.caption).foregroundStyle(.secondary)
            }
            if task == nil, let last = conversation?.messages.last, last.role == "assistant", ["failed","stopped"].contains(last.status ?? "") {
                Button("Reprendre la réponse") {retry()}
            }
            HStack {
                TextField("Message",text:$text,axis:.vertical).lineLimit(1...6)
                if task != nil {Button("Arrêter") {task?.cancel(); confirmation?.resume(returning:false); confirmation = nil; pending = nil}}
                else {Button("Envoyer") {send()}.disabled(text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || !client.isConnected)}
            }.padding()
        }
        .toolbar {
            ToolbarItem {
                Menu("Conversations") {
                    if client.mode == .application {Button("Nouvelle conversation") {conversation = client.newConversation()}}
                    ForEach(client.conversations) {item in Button(item.title) {conversation = item}}
                }.disabled(task != nil)
            }
            ToolbarItem {
                Picker("Modèle",selection:Binding(get:{conversation?.model ?? client.models.first?.id ?? ""},set:{value in if conversation == nil {conversation = client.newConversation()}; conversation?.model = value})) {
                    ForEach(client.models) {model in Text(model.id + (model.supportsTools == true ? " · outils" : "")).tag(model.id)}
                }.disabled(task != nil)
            }
            ToolbarItem {
                Button("Recharger") {Task {do {try await client.reload(); if let id = conversation?.id {conversation = client.conversations.first(where:{$0.id == id})}} catch {self.error = error.localizedDescription}}}.disabled(task != nil)
            }
            #if canImport(UIKit)
            ToolbarItem {
                if !client.isConnected {Button("Se connecter") {Task {do {let presenter = MultiVibeAuthenticationPresenter(window:UIApplication.shared.connectedScenes.compactMap {$0 as? UIWindowScene}.flatMap(\.windows).first(where:{$0.isKeyWindow})); authentication = presenter; try await presenter.signIn(client:client)} catch {self.error = error.localizedDescription}}}}
                else if client.mode == .application {Button("Déconnexion") {Task {do {try await client.disconnect(); conversation = nil} catch {self.error = error.localizedDescription}}}.disabled(task != nil)}
            }
            #endif
        }
        .confirmationDialog("Autoriser cette action ?",isPresented:Binding(get:{pending != nil},set:{if !$0 {resolve(false)}}),titleVisibility:.visible) {
            Button("Autoriser") {resolve(true)}; Button("Refuser",role:.cancel) {resolve(false)}
        } message: {Text(pending.map {"\($0.name)\n\($0.arguments)"} ?? "")}
        .task {do {try await client.connect(); if conversation == nil, client.mode == .application {conversation = client.conversations.first ?? client.newConversation()}} catch {self.error = error.localizedDescription}}
        .onOpenURL {url in Task {do {if let opened = try await client.conversationFromOpenURL(url) {conversation = opened} else {try await client.handleOpenURL(url); conversation = client.conversations.first ?? client.newConversation()}; error = nil} catch {self.error = error.localizedDescription}}}
        .onDisappear {task?.cancel(); resolve(false)}
    }
    private func resolve(_ allowed:Bool) {let continuation = confirmation; confirmation = nil; pending = nil; continuation?.resume(returning:allowed)}
    private func originURL(_ url:URL,conversationID:String) -> URL {
        var components = URLComponents(url:url,resolvingAgainstBaseURL:false)!
        components.queryItems = (components.queryItems ?? []).filter {$0.name != "conversationId"} + [URLQueryItem(name:"conversationId",value:conversationID)]
        return components.url ?? url
    }
    private func retry() {
        guard var value = conversation,value.messages.last?.role == "assistant",value.messages.last?.toolCalls == nil else {return}
        value.messages.removeLast();conversation = value;run(value)
    }
    private func send() {
        var value = conversation ?? client.newConversation()
        guard !value.model.isEmpty else {error = "Choisissez un modèle."; return}
        value.messages.append(MultiVibeMessage(role:"user",content:text))
        if value.messages.count == 1 {value.title = String(text.prefix(80))}
        conversation = value; text = ""; error = nil
        run(value)
    }
    private func run(_ value:MultiVibeConversation) {
        task = Task { @MainActor in
            defer {task = nil}
            do {conversation = try await client.respond(to:value,tools:client.models.first(where:{$0.id == value.model})?.supportsTools == true ? tools : [],contextProvider:contextProvider,confirm:{call in await withCheckedContinuation {continuation in confirmation = continuation; pending = call}},update:{conversation = $0})}
            catch {self.error = error.localizedDescription}
        }
    }
}
#if canImport(UIKit)
import UIKit
@MainActor public final class MultiVibeChatViewController: UIHostingController<MultiVibeChatView> {
    public init(client:MultiVibeClient,tools:[MultiVibeTool] = [],contextProvider:(any MultiVibeContextProvider)? = nil,initialPrompt:String = "") {super.init(rootView:MultiVibeChatView(client:client,tools:tools,contextProvider:contextProvider,initialPrompt:initialPrompt))}
    @available(*,unavailable) required dynamic init?(coder:NSCoder) {fatalError("Use init(client:)")}
}
#endif
