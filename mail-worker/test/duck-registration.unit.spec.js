import { describe, it, expect } from 'vitest';
import {extractDuckRegistration,extractVerificationCode,buildRetrievalResult} from '../src/service/mailbox-tools-service';
import {toPublicCodeResult} from '../src/api/mailbox-tools-api';
const row={emailId:12,sendEmail:'support@duck.com',subject:'Confirm your forwarding address',text:'https://duckduckgo.com/email/verify?otp=alpha-bravo-charlie-delta&user=abcdefgh1234'};
describe('Duck signup verification',()=>{
 it('extracts the exact username and four-word signup token',()=>{
  expect(extractDuckRegistration(row)).toEqual({username:'abcdefgh1234',otp:'alpha-bravo-charlie-delta'});
  expect(extractVerificationCode({...row,code:'2026'}).code).toBe('alpha-bravo-charlie-delta');
 });
 it('handles HTML entities',()=>expect(extractDuckRegistration({...row,text:'',content:row.text.replace('&','&amp;')})).not.toBeNull());
 it('fails closed for wrong sender, host, old-account notices, duplicated or conflicting tokens',()=>{
  for(const r of [{...row,sendEmail:'evil@example.org'},{...row,subject:"You're Already Signed Up"},
    {...row,text:row.text.replace('duckduckgo.com','duckduckgo.com.evil.test')},
    {...row,text:row.text+'&user=other'}, {...row,text:row.text+' '+row.text.replace('alpha','echo')}
   ]) expect(extractDuckRegistration(r)).toBeNull();
 });
 it('returns structured registration without revealing the message body',()=>{
  const result=toPublicCodeResult(buildRetrievalResult([row],{email:'fixture@salvadawn.com',accountId:1}));
  expect(result.messages[0].registration.username).toBe('abcdefgh1234');
  expect(result.messages[0].text).toBeUndefined();
 });
});
