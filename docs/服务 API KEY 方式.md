初次使用元宝搜索服务时，如果您通过服务 API KEY 方式接入服务，可参考本文的指引进行准备工作及入门操作。

|操作步骤|说明|
|---------|---------|
|[步骤一：登录注册](https://cloud.tencent.com/document/product/1806/130615#8270649a-f02c-4f88-ab02-656e5e92894a)|注册腾讯云账号，完成实名认证并登录|
|[步骤二：开通服务](https://cloud.tencent.com/document/product/1806/130615#63b4e9ef-8c65-4a87-9169-627941e751a1)| 控制台自助开通元宝搜索服务|
|[步骤三：获取服务密钥 API KEY](https://cloud.tencent.com/document/product/1806/130615#21242563-b79b-4db5-962a-12a9a39ebc16)|获取元宝搜索的服务密钥 API KEY|
|[步骤四：接入 API](https://cloud.tencent.com/document/product/1806/130615#51c379b3-3766-4aa5-93fb-b60441fcb2fe)|按照 API KEY 兼容模式，通过 API 接入|

## 步骤一：登录注册

注册并通过个人实名认证或企业认证后，登录 [腾讯云](https://cloud.tencent.com/login?s_url=https%3A%2F%2Fcloud.tencent.com%2Fact%2Fpro%2Fwarmup202506%3FfromSource%3Dgwzcw.9800608.9800608.9800608%26utm_medium%3Dcpc%26utm_id%3Dgwzcw.9800608.9800608.9800608)。如果没有账号，请参考 [注册腾讯云](https://cloud.tencent.com/document/product/378/17985)。

## 步骤二：开通服务

进入[元宝搜索控制台](https://console.cloud.tencent.com/wsapi/index) 概览页面，单击**开通服务**，按照 [购买方式](https://cloud.tencent.com/document/product/1806/121799) 文档指引按需完成服务开通和购买。

![](https://qcloudimg.tencent-cloud.cn/image/document/5df7b03d6d78c421aadd85c2b253b32c.png)

## 步骤三：创建服务密钥 API KEY

> **说明：**
> 
> 1. 每个 subuin（包括主账号）最多同时持有**3个**服务密钥 API KEY，请合理创建并分配使用。
> 2. 使用子账号创建和管理服务密钥 API KEY 时，须主账号事先前往 [访问管理控制台](https://console.cloud.tencent.com/cam) 为该子用户授予元宝搜索**（WSA）全读写访问权限**。

1. 进入 [元宝搜索控制台](https://console.cloud.tencent.com/wsapi/index)，在**概览** > **服务 API KEY 方式**界面，单击**创建 API KEY**。

   ![](https://qcloudimg.tencent-cloud.cn/image/document/939edeb077952c24706456e5c4ec7e71.png)

2. 输入服务密钥名称，单击**确定**。

   ![](https://qcloudimg.tencent-cloud.cn/image/document/d6ec59b258356c028142fcf9283ba2ab.png)

3. 弹窗返回您创建的 API KEY，可单击**下载 CSV 文件**保存至本地。或单击**复制**后另行保存。

   > **注意：**
   > 
   > - 为降低服务密钥泄漏的风险，仅在创建时提供明文 API KEY，后续不可再进行查询，请保存好您的 API KEY。
   > - 服务密钥 API KEY 是您请求腾讯云元宝搜索时的安全鉴权凭证。为了您的财产和服务安全，请妥善保存 API KEY，请勿通过任何方式上传或者公开分享您的密钥信息。

   ![](https://qcloudimg.tencent-cloud.cn/image/document/6e4bfd494d150186a99a8c5e3b93d80b.png)

## 步骤四：接入 API

请根据下方接入指引，结合实际业务场景完成接入。

### 接口描述
- 请求协议：HTTPS

- 请求方法：POST

- 接口请求域名： api.wsa.cloud.tencent.com 

- 接口路径（URI）：/SearchPro

- 数据格式：Content-Type: application/json; charset=UTF-8

- 接口参数：参考 [API 文档](https://cloud.tencent.com/document/product/1806/121811) 中的出入参结构

### 示例

#### 输入示例
``` plaintext

POST https://api.wsa.cloud.tencent.com/SearchPro HTTP/1.1
Host: api.wsa.cloud.tencent.com
Content-Type: application/json
Authorization: Bearer sk-209b****e23d

{
    "Query": "三星堆的由来"
}


```

#### 输出示例
``` json

{
    "Response": {
        "Pages": [
            "{\"passage\":\"三星堆名字的由来 三星堆遗址位于四川省广汉市西北部,距离成都约40公里,地理位置独特,被三条河流环绕,形成了天然的地理屏障｡据《华阳国志》记载,古蜀国“有三江,皆发源于岷山,流至成都平原”｡ 这三条河流,即今之鸭子河､石亭江和郪江,在三星堆附近交汇,形成了一片肥沃的土地｡三星堆之名,最初来源于这一地区的地形特征——三座小山丘呈三角状分布,犹如夜空中的三星,故得名“三星堆”｡ 三星堆名称的演变 三星堆遗址的发掘,始于20世纪20年代末期,但其真正引起广泛关注是在1986年两个大型祭祀坑的发现之后｡在此之前,三星堆只是当地的一个地名,直到考古学家们在这里发现了大量的古代遗存,三星堆才逐渐成为了世界瞩目的焦点｡ 随着研究的深入,三星堆之名也从一个简单的地理标识,演变为承载着深厚历史文化的符号｡\",\"score\":0.897802,\"date\":\"2024-06-07 19:00:51\",\"title\":\"三星堆名字的由来,你真的了解吗?三星堆的参观攻略,建议收藏青铜文物玉器古蜀国三星堆遗址_网易订阅\",\"url\":\"https://www.163.com/dy/article/J43Q2STU0553FV3Z.html\",\"site\":\"网易\",\"images\":[],\"favicon\":\"http://img01.sogoucdn.com/app/a/200913/a51423369a5d5a.png\"}",
            "{\"passage\":\"一､地理环境因素三星堆遗址位于四川省广汉市,距离成都约40公里｡在四川省广汉市西北部,有三座稍稍隆起的土堆呈直线排列,这种地形布局与夜空中闪烁的三颗星辰相呼应,因此得名“三星堆”｡这三个土堆历史悠久,据考古学家研究,它们的存在可以追溯到3000多年前｡这三个土堆不仅形态独特,而且在古代具有一定的宗教或象征意义｡在三星堆遗址的东北方,有一段残破的城墙,这段城墙呈现出弯月形状,与三个土堆隔河相望｡这种自然与人工相结合的景观,在当时的社会背景下,很可能被赋予了一定的神话色彩和宗教意义｡这一景观组合在历史上更是被形象地称为“三星伴月”,进一步增添了三星堆名字的文化韵味｡其中的“三星”指的就是那三个土堆,而“月”则是指那段弯月般的城墙｡当地居民根据这一独特的地理特征,赋予了这片土地以“三星伴月”的美称｡这种说法不仅反映了古人对于自然现象的崇拜和敬畏之情,同时也体现了人们对于美好事物的向往和赞美之心｡随着时间的推移,这一称谓逐渐深入人心,并最终演变成了“三星堆”这一名称｡\",\"score\":0.8887853,\"date\":\"2024-09-03 12:59:00\",\"title\":\"三星堆名字的由来_腾讯新闻\",\"url\":\"https://news.qq.com/rain/a/20240903A048N700\",\"site\":\"腾讯网\",\"images\":[],\"favicon\":\"http://img02.sogoucdn.com/app/a/200913/ab735a258a90e8.png\"}",
            "{\"passage\":\"最早在1929年,一位当地农民在遗址区域内偶然发现了一个玉器坑,这一发现引起了考古界的关注｡在四川省广汉市西北部,有<strong>三座稍稍隆起的土堆呈直线排列</strong>,这种地形布局与夜空中闪烁的<strong>三颗星辰</strong>相呼应,因此得名<strong>“三星堆”</strong>｡\",\"score\":0.86471426,\"date\":\"2024-09-03 13:06:46\",\"title\":\"三星堆名字的由来\",\"url\":\"https://so.html5.qq.com/page/real/search_news?docid=70000021_14266d6996591252\",\"site\":\"企鹅号\",\"images\":[],\"favicon\":\"http://img02.sogoucdn.com/app/a/200913/ab735a25.png\"}"
        ],
        "Query": "三星堆的由来",
        "RequestId": "6f8df221-9a68-4ea2-90d6-a9590cae244c"
    }
}

```

### 错误码

当请求出现错误时，将返回 Error 对象，Error.Code 包含以下错误值：
<table>
<tr>
<td rowspan="1" colspan="1" ><strong>错误码</strong></td>

<td rowspan="1" colspan="1" ><strong>描述</strong></td>

<td rowspan="1" colspan="1" ><strong>说明</strong></td>
</tr>

<tr>
<td rowspan="1" colspan="1" >InternalError</td>

<td rowspan="1" colspan="1" >内部错误。</td>

<td rowspan="1" colspan="1" >-</td>
</tr>

<tr>
<td rowspan="1" colspan="1" >InvalidParameter</td>

<td rowspan="1" colspan="1" >参数错误。</td>

<td rowspan="1" colspan="1" >-</td>
</tr>

<tr>
<td rowspan="1" colspan="1" >RequestLimitExceeded</td>

<td rowspan="1" colspan="1" >请求的次数超过了频率限制。</td>

<td rowspan="1" colspan="1" >-</td>
</tr>

<tr>
<td rowspan="1" colspan="1" >ResourceNotFound</td>

<td rowspan="1" colspan="1" >用户资源未开通。</td>

<td rowspan="1" colspan="1" >请开通服务。</td>
</tr>

<tr>
<td rowspan="1" colspan="1" >ResourceUnavailable</td>

<td rowspan="1" colspan="1" >用户资源不可用。</td>

<td rowspan="1" colspan="1" >请检查账号是否欠费。</td>
</tr>

<tr>
<td rowspan="1" colspan="1" >UnauthorizedOperation</td>

<td rowspan="1" colspan="1" >未授权操作。</td>

<td rowspan="1" colspan="1" >请检查服务密钥 API KEY 是否正确。</td>
</tr>
</table>

### 完整请求代码示例

#### Python 示例
``` python
# 本代码仅供参考，具体请参照接口文档和实际需求进行开发

import os
import hashlib
import hmac
import json
import sys
import time
from datetime import datetime
if sys.version_info[0] <= 2:
    from httplib import HTTPSConnection
else:
    from http.client import HTTPSConnection

# 密钥信息从环境变量读取，需要提前在环境变量中设置 TENCENTCLOUD_WSA_APIKEY
# 使用环境变量方式可以避免密钥硬编码在代码中，提高安全性
# 生产环境建议使用更安全的密钥管理方案，如密钥管理系统(KMS)、容器密钥注入等
# 密钥可前往官网控制台进行获取
secret_key = os.getenv("TENCENTCLOUD_WSA_APIKEY")

payload = "{\"Query\":\"三星堆的由来\"}"
params = json.loads(payload)
host = "api.wsa.cloud.tencent.com"
http_request_method = "POST"
uri = "/SearchPro"

# ************* 构造并发起请求 *************
headers = {
    "Authorization": "Bearer " + secret_key,
    "Content-Type": "application/json; charset=utf-8",
}

try:
    req = HTTPSConnection(host)
    req.request(http_request_method, uri, headers=headers, body=payload.encode("utf-8"))
    resp = req.getresponse()
    print(resp.read().decode("utf-8"))
except Exception as err:
    print(err)
```

#### Java 示例
``` java

// 本代码仅供参考，具体请参照接口文档和实际需求进行开发

import io.pyroscope.okhttp3.MediaType;
import io.pyroscope.okhttp3.OkHttpClient;
import io.pyroscope.okhttp3.Request;
import io.pyroscope.okhttp3.RequestBody;
import io.pyroscope.okhttp3.Response;
import java.io.IOException;

public class Main {
    public static void main(String[] args) throws IOException {
        // 密钥信息从环境变量读取，需要提前在环境变量中设置 TENCENTCLOUD_WSA_APIKEY
        // 使用环境变量方式可以避免密钥硬编码在代码中，提高安全性
        // 生产环境建议使用更安全的密钥管理方案，如密钥管理系统(KMS)、容器密钥注入等
        // 密钥可前往官网控制台进行获取
        String apiKey = System.getenv("TENCENTCLOUD_WSA_APIKEY");
        String body = "{\"Query\":\"三星堆的由来\"}";
        String resp = doRequest(body, apiKey);

        System.out.println(resp);
    }

    // singleton client for connection reuse and better performance
    private static final OkHttpClient client = new OkHttpClient();

    public static String doRequest(String body, String apiKey) throws IOException {

        Request request = buildRequest(body, apiKey);

        System.out.println(request.method() + " " + request.url());
        System.out.println(request.headers());
        System.out.println(body);

        Response response = client.newCall(request).execute();
        return response.body().string();
    }

    public static Request buildRequest(String body, String apiKey) {
        String contentType = "application/json; charset=utf-8";
        return new Request.Builder()
                .header("Content-Type", contentType)
                .header("Authorization", "Bearer " + apiKey)
                .url("https://api.wsa.cloud.tencent.com/SearchPro")
                .post(RequestBody.create(MediaType.parse(contentType), body))
                .build();
    }

}
```

