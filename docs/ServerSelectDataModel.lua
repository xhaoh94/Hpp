local ServerSelectDataModel = BaseClass('ServerSelectDataModel', Singleton)
local serverListData = {
    -- [1] = {
    --     zone_id = 1,
    --     name = '340001',
    --     ip = '192.168.60.106',
    --     platform = '100',
    --     port = 8001,
    --     isnew = 1,
    --     is_full = 0,
    --     maintain = 0,
    --     srv_status = 0,
    --     roles = {}
    -- },
    -- [2] = {
    --     zone_id = 2,
    --     name = '340002',
    --     ip = '192.168.60.67',
    --     platform = '200',
    --     port = 8001,
    --     isnew = 0,
    --     is_full = 0,
    --     maintain = 0,
    --     srv_status = 0,
    --     roles = {}
    -- },
    -- [3] = {
    --     zone_id = 3,
    --     name = '340003',
    --     ip = '192.168.60.83',
    --     platform = '207',
    --     port = 8001,
    --     isnew = 0,
    --     is_full = 0,
    --     maintain = 0,
    --     srv_status = 0,
    --     roles = {}
    -- },
    -- [4] = {
    --     zone_id = 4,
    --     name = '340004',
    --     ip = '192.168.60.199',
    --     platform = '206',
    --     port = 8001,
    --     isnew = 0,
    --     is_full = 0,
    --     maintain = 0,
    --     srv_status = 0,
    --     roles = {}
    -- }
}

local _clientInterceptConfigMap = {}

local _haveRoleKey = 1 --拥有角色Key
local _recommendKey = 2 --推荐大区Key
ServerSelectDataModel._haveRoleKey = _haveRoleKey
ServerSelectDataModel._recommendKey = _recommendKey

local math = require('math')
local function __init(self)
    self:RigsterRed()
    self:AddListener()
    self.serverListDic = {}
    self.simpleServerList = {}
    self.serverSimpleInfoMap = {}   --主要是提供外部查找一些简要信息
    for k, v in pairs(serverListData) do
        v.localData = true --本地写死的的
        if k < 2 then
            if self.serverListDic[1] == nil then
                self.serverListDic[1] = {}
            end
            table.insert(self.serverListDic[1], v)
        end
        local key = math.ceil(k / 100) + 1
        if self.serverListDic[key] == nil then
            self.serverListDic[key] = {}
        end
        table.insert(self.serverListDic[key], v)
    end

    local sponsorCfg = ConfigManager.mixdata[117001].Value_2
    self.sponsorCfgMap = {}
    for _1, _temp in ipairs(sponsorCfg) do
        for i,v in ipairs(_temp[3]) do
            self.sponsorCfgMap[v[1]] = v
        end
    end
end


function ServerSelectDataModel:ClearServerInfo()
    for k,v in pairs(self.serverListDic) do
        v = {}
    end
    self.simpleServerList = {}
    self.roleServerData = nil
    self.targetServerData = nil
    
end

-- 红点注册
function ServerSelectDataModel:RigsterRed()
end

-- 事件监听
function ServerSelectDataModel:AddListener()
end

-- 是否有国际服列表
function ServerSelectDataModel:IsReqMix11405()
    if not self.mix11405 then
        self.mix11405 = {}
        local mix = ConfigManager.GetConfig("mixdata", 11405).Value_2
        for k, v in pairs(mix) do
            self.mix11405[v] = v
        end
    end
    local currentGid = Define.configChannelOpt and tonumber(Define.configChannelOpt.Gid) or nil
    return self.mix11405[currentGid]
end
function ServerSelectDataModel:ReqMix11405()
    local currentGid = Define.configChannelOpt and tonumber(Define.configChannelOpt.Gid) or nil
    self.nextReq11405 = currentGid
end
function ServerSelectDataModel:HttpGetRequest(curAccount, requestComplete)
    --防止请求不到服务器列表做的存储容错
    --local content = CommonUtil.GetLocalValue(game.GetPrefsKey("server_data"), "")
    local severObj = self:GetServerDataCache()
    if severObj then
        self:ParseSeverObjData(severObj)
        self.serverListDic[_haveRoleKey] = {}
        table.insert(self.serverListDic[_haveRoleKey], severObj)   
        local key = severObj.group_id + _recommendKey   --_recommendKey  : 偏移值
        if self.serverListDic[key] == nil then
            self.serverListDic[key] = {}
        end
        if severObj.cli_status == ServerStatus.Hot then
            self.lastHotServer = severObj
        end
        table.insert(self.serverListDic[key], severObj)    
    end

    local requestCallBack =
        Bind(
        self,
        function(self, jsonStr)
            local ok, dic = CommonUtil.DecodeJson(jsonStr)
            if ok then
                self.nextReq11405 = nil
                self.serverListDic = {}
                self.simpleServerList = {}
                self.serverSimpleInfoList = {}
                local msg = dic['msg']
                local tempList = {}
                tempList[_haveRoleKey] = msg['role_srv_list']
                tempList[_recommendKey] = msg['new_srv_list']
                for _type, list in pairs(tempList) do
                    if #list > 0 then
                        self.serverListDic[_type] = {}
                        for k, severObj in ipairs(list) do
                            self:ParseSeverObjData(severObj, k)
                            table.insert(self.serverListDic[_type], severObj)
                            self:AddToSimpleInfoMap(1, severObj)
                        end
                    end
                end
                local simpleGroupMap = msg['group_list']
                for groupId, serverGroup in pairs(simpleGroupMap) do
                    local simpleGroupData = self:ParseSimpleServerGroup(serverGroup)
                    table.insert(self.simpleServerList, simpleGroupData)
                end
                table.sort(self.simpleServerList, function(group1, group2)
                    return group1.groupId < group2.groupId
                end)
            end
            requestComplete()
            TWDataCollection:SendPivotalData(TWDataCollection.ProcessId.ServerList)
        end
    )

    local gameName = 'develop'
    local chanleId = 1
    local pid = 1
    local gid = 0
    local sdkCId = 0
    local ip = "http://www.eureka.com:9002"
    if Define.isSuper then 
        if nil == Define.configChannelOpt then 
            UIManager.ShowTips(1, '找不到channelpoptdata配置:')
        else
            gameName = Define.packageGameName
            chanleId = Define.configChannelOpt.Cid
            pid = Define.configChannelOpt.Pid
            sdkCId = Define.configChannelOpt.SDKCId
            if Define.isReviewVersion then   --审核包
                ip = Define.configChannelOpt.ReviewUrl
            else
                ip = Define.configChannelOpt.RegUrl
            end
        end
    elseif SDKInstance:GetInstance():IsUseSDK() then
        --走SDK
        gameName = Define.packageGameName
        chanleId = Define.configChannelOpt.Cid
        pid = Define.configChannelOpt.Pid
        sdkCId = Define.configChannelOpt.SDKCId
        gid = Define.configChannelOpt.Gid
        if Define.isReviewVersion then   --审核包
            ip = Define.configChannelOpt.ReviewUrl
        else
            ip = Define.configChannelOpt.RegUrl
        end
    elseif not Define.isEditor then
        --普通外网
        if Define.isTest then
            gameName = 'mmo'
            chanleId = 1
            pid = 1
            sdkCId = 0
        else
            gameName = Define.packageGameName
            chanleId = Define.configChannelOpt.Cid
            pid = Define.configChannelOpt.Pid
            sdkCId = Define.configChannelOpt.SDKCId
            gid = Define.configChannelOpt.Gid
        end
        if Define.isReviewVersion then   --审核包
            ip = "http://115.29.188.199:9002"
        else
            ip = "https://qhmlr-register-dev.eurekl.com:9001"
        end
    end

    self.reqAcccount = curAccount
    self.gameName = gameName
    self.chanleId = chanleId
    self.pid = pid
    self.gid = gid
    self.sdkCId = sdkCId
    self.ip = ip

    local date = os.date("%Y%m%d%H") --年-月-日-时
    --local url = string.format('%s/index.php/server/rolelists?chanleId=%d&pid=%d&gid=%d&sdkcid=%d&account=%s&gameName=%s', ip, chanleId, pid, gid, sdkCId,curAccount, gameName)
    local areaGidParam = self.nextReq11405 and string.format("&areaGid=%d", self.nextReq11405) or ""
    local url = string.format('%s/index.php/server/simplelists?chanleId=%d&pid=%d&gid=%d&sdkcid=%d&account=%s&gameName=%s&lang=%s&date=%s%s', 
        ip, 
        chanleId, 
        pid, 
        gid, 
        sdkCId, 
        curAccount, 
        gameName,
        DriverDefine.originalLanguage,
        date,
        areaGidParam
    )
    -- local url = string.format('http://124.71.194.41:9002/index.php/server/lists?chanleId=1&pid=1&account=xx&gameName=develop', curAccount)
    log("url:".. url)
    CS.ChinarWebRequest.SendRequest(url, requestCallBack)
end

--解析服务器对象
function ServerSelectDataModel:ParseSeverObjData(v, dataIdx)
    v.cli_status = tonumber(v.cli_status)
    v.group_id = tonumber(v.group_id)
    v.open_time = tonumber(v.open_time)
    v.platform = tonumber(v.platform)
    v.port = tonumber(v.port)
    v.srv_status = tonumber(v.srv_status)
    v.zone_id = tonumber(v.zone_id)
    v.maintain = tonumber(v.maintain)

    local toNo = tonumber(v.name)
    if toNo then
        v.name = TO_LANGUAGE(toNo)
    end

    v.effect_id = tonumber( v.effect_id) or 0

    v.dataIdx = dataIdx or 1
    v.isNewServer = ServerStatus.New == v.cli_status   --是否新服
    v.is_hide = tonumber(v.is_hide) or 0
    --前端服务器登录拦截
    v.clientInterceptInfo = self:ParseClientInterceptInfo(v.zone_id)
end

function ServerSelectDataModel:ParseSimpleServerGroup(serverGroup)
    local groupId = tonumber(serverGroup.group_id)
    local data = {}
    data.key = groupId + _recommendKey
    data.groupId = groupId
    data.groupName = serverGroup.group_name
    for i, v in ipairs(serverGroup.srvs) do
        self:AddToSimpleInfoMap(2, v)
    end
    return data
end

function ServerSelectDataModel:ParseClientInterceptInfo(zoneId)
    if _clientInterceptConfigMap[zoneId] then 
        return _clientInterceptConfigMap[zoneId] 
    end
    local configChannelOpt = Define.configChannelOpt
    if configChannelOpt and configChannelOpt.LoginViewTipsServerList and #configChannelOpt.LoginViewTipsServerList > 0 then
        local idx
        for i,range in pairs(configChannelOpt.LoginViewTipsServerList) do
            if zoneId >= range[1] and zoneId <= range[1] then
                idx = i
                break
            end
        end
        if idx then
            local content = configChannelOpt.LoginViewTipsContent[idx]
            if content and content[1] then
                _clientInterceptConfigMap[zoneId] = string.split(content[1],"&")
                return _clientInterceptConfigMap[zoneId]
            end
        end
    end
end

--前端拦截，并弹窗
function ServerSelectDataModel:IsClientInterceptLogin(serverData)
    if serverData and serverData.clientInterceptInfo then
        local servetTime = Time:GetServerTime()
        if tonumber(serverData.clientInterceptInfo[1]) <= servetTime and servetTime <= tonumber(serverData.clientInterceptInfo[2]) then
            return true
        end
    end
    return false
end

function ServerSelectDataModel:ShowChannelLoginTips(content)
    if StringUtil.IsNullOrEmpty(content) then return nil end
    local params = {}
    params.title = TO_LANGUAGE(430007)
    params.tip = TO_LANGUAGE(LanguageManager:GetInstance():WrapSpecalStr(content))
    params.confirmBtnText = TO_LANGUAGE(18)
    params.hideCancelBtn = true
    UIManager.ShowCommonDialogView( params)
end

-- 获取表格数据
function ServerSelectDataModel:GetServerListDic()
    return self.serverListDic
end

function ServerSelectDataModel:GetServerGroupTabDataList()
    local tabDataList = {}
    local list = self.serverListDic[_haveRoleKey]
    if list and #list > 0 then
        local t = {}
        t.key = _haveRoleKey
        t.tabName = TO_LANGUAGE(330001)
        table.insert(tabDataList, t)
    end
    list = self.serverListDic[_recommendKey]
    if list and #list > 0 then
        local t = {}
        t.key = _recommendKey
        t.tabName = TO_LANGUAGE(330002)
        table.insert(tabDataList, t)
    end
    for i, v in ipairs(self.simpleServerList) do
        local t = {}
        t.key = v.key
        t.tabName = v.groupName
        table.insert(tabDataList, t)
    end
    return tabDataList
end

-- 获取已有角色服务器列表
function ServerSelectDataModel:GetExistRoleServerListDic()
    return self.serverListDic[_haveRoleKey]
end

function ServerSelectDataModel:SetTargetServerData(serverData)
    self.targetServerData = serverData
end

--处理数据排序
function ServerSelectDataModel:SortedServerDataList(dataList)
    table.sort(dataList, function(data1, data2)
        if data1.isNewServer == data2.isNewServer then
            return data1.dataIdx < data2.dataIdx
        end
        return data1.isNewServer
    end)
end

function ServerSelectDataModel:GetSortedServerListBykey(key, callback)
    self.searchGroupKey = key
    if key == nil or callback == nil then
        return
    end
    local list = self.serverListDic[key]
    if list then
        callback(list)
        return
    end
    local groupId = nil
    for i, v in ipairs(self.simpleServerList) do
        if v.key == key then
            groupId = v.groupId
            break
        end
    end
    local emptyTab = {}
    if groupId == nil or self.ip == nil or self.reqAcccount == nil then
        callback(emptyTab)
        return
    end
    local requestCallBack = function(jsonStr)
        local ok, dic = CommonUtil.DecodeJson(jsonStr)
        if ok then
            local _msg = dic['msg']
            local _groupdId = tonumber(_msg.group_id)
            local _key = _groupdId + _recommendKey
            local _serverList = _msg.server_list
            self.serverListDic[_key] = {}
            for k, severObj in ipairs(_serverList) do
                self:ParseSeverObjData(severObj, k)
                table.insert(self.serverListDic[_key], severObj)
            end
            self:SortedServerDataList(self.serverListDic[_key])
            if self.searchGroupKey == _key then
                callback(self.serverListDic[_key])
            end
        else
            callback(emptyTab)
        end
    end

    local url = string.format('%s/index.php/server/simplegroup?chanleId=%d&pid=%d&gid=%d&sdkcid=%d&account=%s&gameName=%s&groupId=%s&lang=%s', self.ip, self.chanleId, self.pid, self.gid, self.sdkCId, self.reqAcccount, self.gameName, groupId,DriverDefine.originalLanguage)
    if Define.isEditor or Define.isTest then
        log('group url:', url)
    end
    CS.ChinarWebRequest.SendRequest(url, requestCallBack)
end

--为玩家生成一个合适的服务器
function ServerSelectDataModel:GenBefittingServerData()
    self.roleServerData = nil
    if self.targetServerData then   --如果手动选服了，使用手动选的服
        self.roleServerData = self.targetServerData
    end
    --先从已有角色里面获取服务器，如果没有再从新服列表随机一个
    if self.roleServerData == nil then
        local hasRoleList = self.serverListDic[_haveRoleKey]
        if hasRoleList then
            if self.roleServerData == nil then
                for i, v in ipairs(hasRoleList) do
                    if v.is_last == 1  then
                        self.roleServerData = v
                        break
                    end
                end
            end
        end
    end

    if self.roleServerData == nil then
        local curTime = Time:GetServerTime()
        local tempList = {}
        if self.serverListDic[_recommendKey] then   --(从新服列表随机一个出来)
            for i, v in ipairs(self.serverListDic[_recommendKey]) do
                if v.maintain == 0 and curTime >= v.open_time then  --开放了才有效,并且到了开服时间
                    TABLE_INSERT(tempList, v)
                end
            end
        end
        if #tempList > 0 then
            local index =  Mathf.Random(#tempList)
            self.roleServerData = tempList[index]
        end
    end

    if self.roleServerData == nil then
        self.roleServerData = self.lastHotServer
    end
end

function ServerSelectDataModel:GetCurServerData()
    return self.roleServerData
end

function ServerSelectDataModel:SetCurAccount(value)
    self.curAccount = value
end

function ServerSelectDataModel:GetCurAccount(id)
    return self.curAccount
end

-- key:platform_zond    value：目前只有name
function ServerSelectDataModel:AddToSimpleInfoMap(op, data)
    local simpleInfo = {}
    if op == 1 then
        simpleInfo.name = data.name
        self.serverSimpleInfoList[data.platform.."_"..data.zone_id] = simpleInfo
    else
        simpleInfo.name = data.name
        self.serverSimpleInfoList[data.id] = simpleInfo
    end
end

function ServerSelectDataModel:GetServerDataByZP(z,p)
    local key = p.."_"..z
    return self.serverSimpleInfoList[key]
end

function ServerSelectDataModel:CheckServerHaveRole(platform, zone_id)
    local haveRoleList = self.serverListDic[_haveRoleKey]
    if haveRoleList then
        for i, v in ipairs(haveRoleList) do
            if v.platform == platform and v.zone_id == zone_id then
                return true
            end
        end
    end
    return false
end

function ServerSelectDataModel:CheckServerIsNew(platform, zone_id)
    local newList = self.serverListDic[_recommendKey]
    if newList then
        for i, v in ipairs(newList) do
            if v.platform == platform and v.zone_id == zone_id then
                return true
            end
        end
    end
    return false
end

function ServerSelectDataModel:GetRecommendServerList()
    return self.serverListDic[_recommendKey]
end

function ServerSelectDataModel:CacheServerData(serverData)
    PlayerData.Set("serverData", serverData, "servercache")
    PlayerData.Save()
end

function ServerSelectDataModel:GetServerDataCache()
    return PlayerData.Get( "serverData", "servercache")
end

function ServerSelectDataModel:GetSponsorCfg(id)
    return self.sponsorCfgMap[id]
end

ServerSelectDataModel.__init = __init

return ServerSelectDataModel
