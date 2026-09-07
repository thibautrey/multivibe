package main

import (
 "context"
 "encoding/base64"
 "encoding/json"
 "errors"
 "net/http"
 "net/http/httptest"
 "net/url"
 "path/filepath"
 "reflect"
 "strings"
 "testing"
 "time"
)

type cloudIntegrationBackend struct {
 requests []runtimeExecuteRequest
 fail bool
}
func (*cloudIntegrationBackend) CommunityRuntimeID() string { return "ollama" }
func (*cloudIntegrationBackend) CommunityCatalog() []communityModelBinding {
 return []communityModelBinding{{CanonicalModelID:"hf:qwen/qwen2.5-0.5b-instruct",UpstreamModel:"qwen2.5:0.5b",ContentDigest:"sha256:"+strings.Repeat("a",64),RuntimeID:"ollama"}}
}
func (b *cloudIntegrationBackend) Execute(_ context.Context, r runtimeExecuteRequest) (runtimeExecuteResult,error) {
 b.requests = append(b.requests,r)
 if b.fail { return runtimeExecuteResult{},errors.New("private runtime diagnostic") }
 return runtimeExecuteResult{Output:[]byte(`{"choices":[{"message":{"content":"hello"}}]}`)},nil
}
func (b *cloudIntegrationBackend) ExecuteStream(_ context.Context, r runtimeExecuteRequest, emit func(runtimeExecuteChunk)error) (runtimeExecutionSummary,error) {
 b.requests = append(b.requests,r)
 if err := emit(runtimeExecuteChunk{Output:[]byte("data: {\"choices\":[]}\n\n")}); err != nil { return runtimeExecutionSummary{},err }
 if b.fail { return runtimeExecutionSummary{},errors.New("private runtime diagnostic") }
 return runtimeExecutionSummary{},emit(runtimeExecuteChunk{Output:[]byte("data: [DONE]\n\n"),Final:true})
}

func TestWorkerCloudIntegrationCommunityClaimExecuteAndReturn(t *testing.T) {
 for _, scenario := range []struct{name string; stream,fail bool}{
  {"json",false,false},{"stream",true,false},{"backend_failure",false,true},{"stream_failure",true,true},
 } {
  t.Run(scenario.name,func(t *testing.T){
   now := time.Now().UTC().Truncate(time.Millisecond)
   claim,key := signedCommunityOutboundClaimForStream(t,now,scenario.stream)
   session := &communityOutboundSession{Token:base64.RawURLEncoding.EncodeToString(make([]byte,32)),ExpiresAt:now.Add(time.Minute).Format("2006-01-02T15:04:05.000Z"),PollAfterMS:250}
   // Receipts are read only after the synchronous HTTP calls have completed.
   receipts := make(chan map[string]any,8)
   cloud := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
    w.Header().Set("content-type","application/json")
    if r.Method != http.MethodPost || r.Header.Get("authorization") != "Bearer "+session.Token { t.Error("invalid Cloud request authentication or method"); w.WriteHeader(401); return }
    if r.URL.Path == "/provider/v1/inference-jobs/claim" { _ = json.NewEncoder(w).Encode(claim); return }
    suffix := "/complete"; if scenario.stream { suffix = "/chunks" }
    if r.URL.Path != "/provider/v1/inference-jobs/"+claim.JobID+suffix && r.URL.Path != "/provider/v1/inference-jobs/"+claim.JobID+"/complete" { t.Errorf("unexpected Cloud path: %s",r.URL.Path); http.NotFound(w,r);return }
    var body map[string]any
    if json.NewDecoder(r.Body).Decode(&body) != nil { t.Error("invalid result JSON") }
    if body["leaseId"] != claim.LeaseID { t.Error("result lost lease binding") }
    receipts <- body
    w.WriteHeader(201); _,_ = w.Write([]byte(`{}`))
   }))
   defer cloud.Close()
   sessions := &communityOutboundSessionStore{}
   if err := sessions.replace(session,now); err != nil { t.Fatal(err) }
   enrollment := newMemoryCloudEnrollmentStore()
   enrollment.current = &cloudEnrollmentView{ProviderID:claim.Wire.Envelope.Payload.ProviderID}
   yes,no := true,false
   policy := newMemoryCapacityPolicyStore()
   policy.current = &capacityPolicyStateDocument{Paused:&no,AllowCloudWorkloads:&yes}
   path := filepath.Join(t.TempDir(),"replay.json")
   replay,err := openCommunityOutboundReplayStore(path); if err != nil {t.Fatal(err)}
   backend := &cloudIntegrationBackend{fail:scenario.fail}
   base,err := url.Parse(cloud.URL);if err != nil {t.Fatal(err)}
   worker,err := newCommunityOutboundWorker(base,cloud.Client(),sessions,enrollment,policy,backend,"ollama",trustedProviderDemandKeys{claim.Wire.Envelope.Signature.KeyID:key},replay)
   if err != nil {t.Fatal(err)}
   ctx,cancel := context.WithTimeout(context.Background(),5*time.Second);defer cancel()
   received,err := worker.claim(ctx,session);if err != nil || received == nil {t.Fatalf("claim: %v",err)}
   if !reflect.DeepEqual(*received,claim) {t.Fatal("HTTP claim changed the signed wire request")}
   worker.execute(ctx,*received)
   if len(backend.requests)!=1 {t.Fatalf("backend executions: %d",len(backend.requests))}
   input,_ := base64.RawURLEncoding.DecodeString(claim.Wire.Body)
   request := backend.requests[0]
   if request.ModelID!=backend.CommunityCatalog()[0].CanonicalModelID || request.ExecutionID!=claim.JobID || string(request.Input)!=string(input) {t.Fatalf("runtime request lost model/job/body binding: %#v",request)}
   count:=1;if scenario.stream {count=2}
   for i:=0;i<count;i++ {
    var receipt map[string]any
    select {case receipt= <-receipts:default:t.Fatal("missing Cloud result")}
    raw,err:=base64.RawURLEncoding.DecodeString(receipt["body"].(string));if err!=nil {t.Fatal(err)}
    if strings.Contains(string(raw),"private runtime diagnostic") {t.Fatal("runtime diagnostic leaked")}
    if scenario.stream {
     if receipt["sequence"]!=float64(i) || receipt["final"]!=(i==1) {t.Errorf("stream ordering/finality: %#v",receipt)}
     expected:="data: {\"choices\":[]}\n\n"
     if i==1 {expected="data: [DONE]\n\n";if scenario.fail {expected="event: error\ndata: {\"error\":{\"code\":\"community_inference_backend_failed\"}}\n\n"}}
     if string(raw)!=expected {t.Errorf("stream body: %q",raw)}
    } else {
     status,disposition:=float64(200),"executed"
     if scenario.fail {status,disposition=502,"uncertain"}
     if receipt["status"]!=status || receipt["disposition"]!=disposition {t.Errorf("completion: %#v",receipt)}
     expected:=`{"choices":[{"message":{"content":"hello"}}]}`
     if scenario.fail {expected=`{"error":{"code":"community_inference_backend_failed"}}`}
     if string(raw)!=expected {t.Errorf("completion body: %q",raw)}
    }
   }
   // Restart the replay store and redeliver the same leased job. It must never
   // execute a second time, including after a partial stream or engine error.
   worker.replay,err=openCommunityOutboundReplayStore(path);if err!=nil {t.Fatal(err)}
   worker.execute(ctx,*received)
   if len(backend.requests)!=1 {t.Fatal("redelivered job executed twice")}
   select {case receipt:= <-receipts:if receipt["disposition"]!="uncertain" || receipt["status"]!=float64(502) {t.Errorf("replay completion: %#v",receipt)};default:t.Fatal("missing replay completion")}
   if len(receipts)!=0 {t.Fatal("unexpected extra results")}
  })
 }
}
