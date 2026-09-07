import test from 'node:test';
import assert from 'node:assert/strict';
import {umbrelPackage} from './generate.mjs';
const descriptor = {digest: 'sha256:'+'a'.repeat(64),mediaType:'application/vnd.oci.image.index.v1+json',manifests:['amd64','arm64'].map(architecture=>({digest:'sha256:'+'b'.repeat(64),platform:{os:'linux',architecture}}))};
test('Umbrel pins a multiarch index and preserves proxy authentication and data',()=>{
 const files=umbrelPackage('1.2.3',descriptor);
 const services=files['docker-compose.yml'].services;
 assert.equal(services.server.image,'ghcr.io/thibautrey/multivibe-host-umbrel:1.2.3@'+descriptor.digest);
 assert.equal(services.server.platform,undefined);
 assert.equal(services.server.ports,undefined);
 assert.deepEqual(services.app_proxy.environment,{APP_HOST:'multivibe-host_server_1',APP_PORT:1455});
 assert.equal(services.server.environment.MULTIVIBE_HOST_PUBLIC_URL,'http://${DEVICE_DOMAIN_NAME}:${APP_PROXY_PORT}');
 assert.deepEqual(services.server.volumes,['${APP_DATA_DIR}/data:/data','${APP_DATA_DIR}/models:/models']);
});
test('Umbrel rejects incomplete or unpinned images',()=>{
 for(const input of [{...descriptor,digest:'latest'},{...descriptor,manifests:descriptor.manifests.slice(0,1)},{...descriptor,mediaType:'application/vnd.oci.image.manifest.v1+json'}]) assert.throws(()=>umbrelPackage('1.2.3',input));
 assert.throws(()=>umbrelPackage('1.2.3-beta.1',descriptor));
});
