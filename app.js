const express = require('express');
const config = require('./API_config');
const line = require('@line/bot-sdk');
const request = require('request');
const app = express();

//번역 api_url
const translate_api_url = 'https://openapi.naver.com/v1/papago/n2mt';

//언어감지 api_url
const languagedetect_api_url = 'https://openapi.naver.com/v1/papago/detectLangs';

// API_config.js 의 형태는 다음과 같다.
// const client_id = 'xxxx';
// const client_secret = 'xxxx';

// const line_channel = {
//   channelAccessToken: 'xxxx',
//   channelSecret: 'xxxx',
// };

// Naver Auth Key
//새로 발급받은 naver papago api id, pw 입력
const client_id = config.client_id;
const client_secret = config.client_secret;
// Line Channel Access Tocken
const line_channel = config.line_channel;

// create LINE SDK client
const client = new line.Client(line_channel);

// ELB health checker
app.get('/', (req, res) => {
	console.log('ELB health check');
	res.writeHead(200, { "Content-Type": "text/html" });
	res.end();
});

// register a webhook handler with middleware
app.post('/webhook', line.middleware(line_channel), (req, res) => {
	// webhook 요청에 대해 순차적으로 다음을 수행한다.
	// 전체 수행은 순차수행이기 때문에 동기처리 필요 => async await 패턴을 사용한다
	const promises = req.body.events.map(async (event) => {
		// 메세지의 속성을 확인하고 API connector를 만든다
		let api_connector = await api_connect(event);
		// connector를 통해 언어 감지, 번역 target 언어를 설정한다
		let options = await option_maker(api_connector, event);
		// 설정된 source 및 target으로 번역 결과를 저장한다
		let result = await receive_result(options, event);
		// 모든 작업이 끝나면 client api를 통해 reply를 진행한다.
		client.replyMessage(event.replyToken,result);
	})
	Promise // promise all은 일괄 수행이 완료될 때 then이 수행된다
	.all(promises)
	.then((result) => res.json(result))
    	.catch((err) => {
     	 console.error(err);
     	 res.status(200).end();
    });
});

// language detector api url 및 client id, secret 을 담은 connector를 반환한다.
const api_connect = (event) => {
    return new Promise((resolve, reject) => {
		// 이벤트 타입 검사
		if (event.type !== 'message' || event.message.type !== 'text'){
			// 비정상에 대한 reject 처리
			reject(new Error('메세지 혹은, 텍스트가 아닙니다.'));		
		} else {
			// 정상요청에 대한 connector 생성 및 resolve
			resolve({
				url : languagedetect_api_url,
				form : {'query': event.message.text},
				headers: {'X-Naver-Client-Id': client_id, 'X-Naver-Client-Secret': client_secret}
			});
		}
    })
}

// post 요청으로 api connector를 이용해 language를 분석한 뒤
// source 및 target 설정, 번역 API url을 포함한 options을 반환한다
const option_maker = (api_connector, event) => {
    return new Promise((resolve, reject) => {
		request.post(api_connector, (error,response) => {
    	    console.log(response.statusCode);
        	if(!error && response.statusCode == 200){
				let detect_body = JSON.parse(response.body);
				//언어 감지가 제대로 됐는지 확인
				console.log(detect_body.langCode);
				// 3.zh-CN : 중국어 간체
				// 4.zh-TW : 중국어 번체
				// 5.es : 스페인어
				// 6.fr : 프랑스어
				// 7.vi : 베트남어
				// 8.th : 태국어
				// 9.id : 인도네시아어
				let target = '';
				let checker = true;
				if (detect_body.langCode == 'ko') {
					target = 'en';
					switch (event.message.text.slice(-3)) {
						case '.cn':
							target = 'zh-CN';
							break;
						case '.tw':
							target = 'zh-TW';
							break;
						case '.es':
							target = 'es';
							break;
						case '.fr':
							target = 'fr';
							break;
						case '.vi':
							target = 'vi';
							break;
						case '.th':
							target = 'th';
							break;
						case '.id':
							target = 'id';
							break;
						default:
							checker = false;
							break;
					}
				} else {
					checker = false;
					target = 'ko';
				}
				// 전송된 메세지가 한국어일 경우 default target은 영어이며 설정에 따라 바뀐다.
				// 전송된 메세지가 한국어가 아닐 경우 모든 target language는 한국어가 된다.

				let options = {}
				// checker란 언어 번역시 옵션의 존재 유뮤이다. 사용자가 영어가 아닌 다른 언어의 번역을 원할 경우
				// 뒤에 옵션 .xx 가 붙게 되며 checker 는 true가 된다.
				if (checker)
				{
					options = {
						url:  translate_api_url,
						// checker가 true이면 메세지 끝에 옵션이 붙기 때문에 번역시 이를 무시할 필요가 있다.
						form: {'source':detect_body.langCode, 'target': target, 'text':event.message.text.slice(0,-3)},
						headers: {'X-Naver-Client-Id': client_id, 'X-Naver-Client-Secret': client_secret}
					};
				}
				// 기타 옵션 없는 한 -> 영, 외국어 -> 한글 번역은 checker false
				else{
					options = {
						url:  translate_api_url,
						form: {'source':detect_body.langCode, 'target': target, 'text':event.message.text},
						headers: {'X-Naver-Client-Id': client_id, 'X-Naver-Client-Secret': client_secret}
					}
				}
				// 모든 번역 준비를 마친 options 를 resolve 한다
				resolve(options);
			}
			else{
				// language detection에 대한 예외 reject
				reject(new Error("언어 감지 실패"));
			}
		})
    })
}

// options를 받아서 post 요청을 통해 번역을 실행한다.
// response를 JSON parsing 한 뒤 결과 result에 메세지를 담아서 반환한다.
const receive_result = (options, event) => {
  	return new Promise((resolve, reject) => {
		var result = { type:'text', text: ''};
		// 번역에 관련된 options 객체를 번역 API로 post요청
    	request.post(options, (error, response) => {
      	// Translate API Sucess
			if(!error && response.statusCode == 200){
				// JSON
				var objBody = JSON.parse(response.body);
				// Message 잘 찍히는지 확인
				result.text = objBody.message.result.translatedText;
				console.log(result.text);
				resolve(result);
			}
			else{
				// 번역 정상적으로 불가능시 reject 처리
				result.text = '번역할 수 없는 언어입니다.';
				client.replyMessage(event.replyToken,result);
				reject(new Error("번역 실패"));
			}
  		})
	})
}

// app running
app.listen(3000, function () {
  console.log('Linebot listening on port 3000!');
});
