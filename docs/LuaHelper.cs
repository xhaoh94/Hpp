using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using System.IO;
using System.Runtime.InteropServices;
using TMPro;
using UnityEngine.UI;
using UnityEngine.Networking;
using UnityEngine.Pool;
using System;
using System.Threading;
using System.Threading.Tasks;
using Object = UnityEngine.Object;
using UnityEngine.Rendering.Universal;
using XLua;

#if UNITY_WEBGL
using WeChatWASM;
#endif

public class LuaHelper
{
#if UNITY_OPENHARMONY
    private static OpenHarmonyJSClass _openHarmonyJSObject = null;
#endif
    public static string SDKCall(string method, string argsJson)
    {
        string str = "";
#if UNITY_IOS
        str = CallOC(method, argsJson);
#elif UNITY_OPENHARMONY
        if (null == _openHarmonyJSObject)
            _openHarmonyJSObject = new OpenHarmonyJSClass("SDKCall");

        str = _openHarmonyJSObject.CallStatic<string>(method, argsJson);
#endif
        return str;
    }

#if UNITY_IOS
    [DllImport("__Internal")]
    private static extern string CallOC(string method, string argsJson);
#endif

    public static int IsFileExists(string path)
    {
        return File.Exists(path) ? 1 : 0;
    }

    static List<TMP_Text> _tmpTextList = new List<TMP_Text>();
    static List<MaskableGraphic> _makableGraphicList = new List<MaskableGraphic>();
    static List<Renderer> _tmpRendererList = new List<Renderer>();
    public static void ResetShader(GameObject go)
    {
#if UNITY_EDITOR
        if (Define.isDevelopMode || null == go)
            return;

        go.GetComponentsInChildren(true, _tmpRendererList);
        for (int i = 0; i < _tmpRendererList.Count; i++)
        {
            var renderer = _tmpRendererList[i];
            if (null != renderer)
            {
                var mats = renderer.sharedMaterials;
                for (int j = 0; j < mats.Length; ++j)
                {
                    var mat = mats[j];
                    if (null != mat)
                    {
                        var shader = mat.shader;
                        if (null != shader)
                            mat.shader = Shader.Find(shader.name);
                    }
                }
            }
        }
        _tmpRendererList.Clear();

        go.GetComponentsInChildren(true, _makableGraphicList);
        for (int i = 0; i < _makableGraphicList.Count; ++i)
        {
            var makableGraphic = _makableGraphicList[i];
            var mat = makableGraphic.material;
            if (null != mat)
            {
                var shader = mat.shader;
                if (null != shader)
                    mat.shader = Shader.Find(shader.name);
            }
        }

        go.GetComponentsInChildren(true, _tmpTextList);
        for (int i = 0; i < _tmpTextList.Count; i++)
        {
            var tmp = _tmpTextList[i];
            //Debug.LogError(tmp.font.material);
            if (null != tmp)
            {
                var font = tmp.font;
                if (null != font)
                {
                    var mat = font.material;
                    if (null != mat)
                        mat.shader = Shader.Find(mat.shader.name);
                }
            }
        }

        _tmpTextList.Clear();
#endif
    }

    public static IOException ReadAllBytes(string path, out byte[] bs)
    {
        IOException e = null;
        bs = null;
#if UNITY_WEBGL
        var fs = WX.GetFileSystemManager();
        try
        {
            //Logger.Log("file access:" + fs.AccessSync(path));
            if (fs.AccessSync(path).Equals("access:ok"))
                bs = fs.ReadFileSync(path);
        }
        catch (IOException exception)
        {
            e = exception;
        }
#else
        try
        {
            if (File.Exists(path))
                bs = File.ReadAllBytes(path);
        }
        catch (IOException exception)
        {
            e = exception;
        }

#endif
        return e;
    }

    public static IOException WriteAllBytes(string path, byte[] bs)
    {
        IOException e = null;

#if UNITY_WEBGL && !UNITY_EDITOR
        if (path.StartsWith(WX.env.USER_DATA_PATH))   //必须是WX.env.USER_DATA_PATH目录才能写入
        {
            var fs = WX.GetFileSystemManager();
            try
            {
                EnsureMakeDir(path);
                fs.WriteFileSync(path, bs);
            }
            catch (IOException exception)
            {
                e = exception;
            }
        }
#else
        try
        {
            var dir = Path.GetDirectoryName(path);
            if ("" != dir && !Directory.Exists(dir))
                Directory.CreateDirectory(dir);

            File.WriteAllBytes(path, bs);
        }
        catch (IOException exception)
        {
            e = exception;
        }
#endif
        return e;
    }

    public static async void WriteAllBytesAsync(string path, byte[] bs, Action<string, Task> callback = null)
    {
        try
        {
            var dir = Path.GetDirectoryName(path);
            if ("" != dir && !Directory.Exists(dir))
                Directory.CreateDirectory(dir);

            var task = File.WriteAllBytesAsync(path, bs);
            await task;
            if (null != callback)
                callback(path, task);
        }
        catch (IOException exception)
        {
            Debugger.LogError(exception);
        }
    }

    public static async void WriteAllBytesAsyncEx(string path, UnityWebRequest unityWebRequest, Action<string, UnityWebRequest, BytesPacker, Exception> callback = null, BytesPacker bsPackerBuffer = null)
    {
        var dir = Path.GetDirectoryName(path);
        if (!Directory.Exists(dir))
            Directory.CreateDirectory(dir);

        var bsNative = unityWebRequest.downloadHandler.nativeData;
        var len = bsNative.Length;
        if (null == bsPackerBuffer)
        {
            bsPackerBuffer = new BytesPacker();
            bsPackerBuffer.Init(bsNative.Length);
        }

        var fs = File.OpenWrite(path);

        Task task = null;
        var bsBuffer = bsPackerBuffer._bs;
        var bufferLen = bsPackerBuffer.Length;
        var idx = 0;
        while (idx < len)
        {
            var copyLen = Math.Min(bsNative.Length - idx, bufferLen);
            Unity.Collections.NativeArray<byte>.Copy(bsNative, idx, bsBuffer, 0, copyLen);
            task = fs.WriteAsync(bsBuffer, 0, copyLen);
            await task;
            if (null != task.Exception)
                break;

            idx += copyLen;
        }

        fs.Close();

        if (null != callback)
            callback(path, unityWebRequest, bsPackerBuffer, task.Exception);
    }

    public static IOException WriteAllBytes(string path, UnityWebRequest unityWebRequest)
    {
        IOException e = null;
        try
        {
            var dir = Path.GetDirectoryName(path);
            if ("" != dir && !Directory.Exists(dir))
                Directory.CreateDirectory(dir);

            File.WriteAllBytes(path, unityWebRequest.downloadHandler.data);
        }
        catch (IOException exception)
        {
            e = exception;
        }

        return e;
    }

    public static IOException ReadAllText(string path, out string content)
    {
        IOException e = null;
        content = null;
        try
        {
            if (File.Exists(path))
                content = File.ReadAllText(path);
        }
        catch (IOException exception)
        {
            e = exception;
        }

        return e;
    }

    public static IOException AppendAllText(string path, string content)
    {
        IOException e = null;
        try
        {
            var dir = Path.GetDirectoryName(path);
            if ("" != dir && !Directory.Exists(dir))
                Directory.CreateDirectory(dir);

            File.AppendAllText(path, content);
        }
        catch (IOException exception)
        {
            e = exception;
        }

        return e;
    }

    public static ulong CalcCrc32(UnityWebRequest unityWebRequest)
    {
        if (null == unityWebRequest)
            return 0;

        var crc32 = Crc32.Calc(unityWebRequest.downloadHandler.nativeData);
        return crc32;
    }

    public static void DeleteFile(string path)
    {
        if (!File.Exists(path))
            return;

        File.Delete(path);
    }

    static Dictionary<string, int> _propName2IdMap = new Dictionary<string, int>();
    static Dictionary<int, string> _propId2NameMap = new Dictionary<int, string>();
    static int GetShaderPropId(string propName)
    {
        if (!_propName2IdMap.ContainsKey(propName))
        {
            var propId = Shader.PropertyToID(propName);
            _propName2IdMap.Add(propName, propId);
            _propId2NameMap.Add(propId, propName);
        }

        return _propName2IdMap[propName];
    }

    static string GetShaderPropName(int propId)
    {
        if (!_propId2NameMap.ContainsKey(propId))
            return "null";

        return _propId2NameMap[propId];
    }

    static List<Material> _tmpMaterialList = new List<Material>();
    public static void SetRendererMaterialFloat(GameObject go, int propId, float value, int iIncludeInactive = 1)
    {
        go.GetComponentsInChildren<Renderer>(1 == iIncludeInactive, _tmpRendererList);
        for (int i = 0; i < _tmpRendererList.Count; i++)
        {
            var renderer = _tmpRendererList[i];
            renderer.GetMaterials(_tmpMaterialList);
            for (int j = 0; j < _tmpMaterialList.Count; j++)
            {
                var mat = _tmpMaterialList[j];
#if UNITY_EDITOR
                if (!mat.HasProperty(propId))
                {
                    var propName = GetShaderPropName(propId);
                    if (null == propName)
                        propName = propId.ToString();

                    //Debugger.LogError("mat缺少{0}属性字段,mat:{1},go:{2}", propName, mat.name, go.name);
                    continue;
                }
#endif
                mat.SetFloat(propId, value);
            }
            _tmpMaterialList.Clear();
        }
        _tmpRendererList.Clear();
    }

    public static void SetRendererMaterialFloat(GameObject go, string propName, float value, int iIncludeInactive = 1)
    {
        var propId = GetShaderPropId(propName);
        SetRendererMaterialFloat(go, propId, value, iIncludeInactive);
    }

    public static void SetRendererSharedMaterialFloat(GameObject go, int propId, float value, int iIncludeInactive = 1)
    {
        go.GetComponentsInChildren<Renderer>(1 == iIncludeInactive, _tmpRendererList);
        for (int i = 0; i < _tmpRendererList.Count; i++)
        {
            var renderer = _tmpRendererList[i];
            renderer.GetSharedMaterials(_tmpMaterialList);
            for (int j = 0; j < _tmpMaterialList.Count; j++)
            {
                var mat = _tmpMaterialList[j];
#if UNITY_EDITOR
                if (!mat.HasProperty(propId))
                {
                    //Debugger.LogError("mat缺少{0}属性字段,name:{0}", GetShaderPropName(propId), mat.name);
                    continue;
                }
#endif
                mat.SetFloat(propId, value);
            }
            _tmpMaterialList.Clear();
        }
        _tmpRendererList.Clear();
    }

    public static void SetRendererSharedMaterialFloat(GameObject go, string propName, float value, int iIncludeInactive = 1)
    {
        var propId = GetShaderPropId(propName);
        SetRendererSharedMaterialFloat(go, propId, value, iIncludeInactive);
    }

    public static void SetRendererMaterialColor(GameObject go, int propId, Color value, int iIncludeInactive = 1)
    {
        go.GetComponentsInChildren<Renderer>(1 == iIncludeInactive, _tmpRendererList);
        for (int i = 0; i < _tmpRendererList.Count; i++)
        {
            var renderer = _tmpRendererList[i];
            renderer.GetMaterials(_tmpMaterialList);
            for (int j = 0; j < _tmpMaterialList.Count; j++)
            {
                var mat = _tmpMaterialList[j];
#if UNITY_EDITOR
                if (!mat.HasProperty(propId))
                {
                    var propName = GetShaderPropName(propId);
                    if (null == propName)
                        propName = propId.ToString();

                    //Debugger.LogError("mat缺少{0}属性字段,mat:{1},go:{2}", propName, mat.name, go.name);
                    continue;
                }
#endif
                mat.SetColor(propId, value);
            }
            _tmpMaterialList.Clear();
        }
        _tmpRendererList.Clear();
    }

    public static void SetRendererMaterialColor(GameObject go, string propName, Color value, int iIncludeInactive = 1)
    {
        var propId = GetShaderPropId(propName);
        SetRendererMaterialColor(go, propId, value, iIncludeInactive);
    }

    public static void SetRendererSharedMaterialColor(GameObject go, int propId, Color value, int iIncludeInactive = 1)
    {
        go.GetComponentsInChildren<Renderer>(1 == iIncludeInactive, _tmpRendererList);
        for (int i = 0; i < _tmpRendererList.Count; i++)
        {
            var renderer = _tmpRendererList[i];
            renderer.GetSharedMaterials(_tmpMaterialList);
            for (int j = 0; j < _tmpMaterialList.Count; j++)
            {
                var mat = _tmpMaterialList[j];
#if UNITY_EDITOR
                if (!mat.HasProperty(propId))
                {
                    //Debugger.LogError("mat缺少{0}属性字段,name:{0}", GetShaderPropName(propId), mat.name);
                    continue;
                }
#endif
                mat.SetColor(propId, value);
            }
            _tmpMaterialList.Clear();
        }
        _tmpRendererList.Clear();
    }

    public static void SetRendererSharedMaterialColor(GameObject go, string propName, Color value, int iIncludeInactive = 1)
    {
        var propId = GetShaderPropId(propName);
        SetRendererSharedMaterialColor(go, propId, value, iIncludeInactive);
    }

    public static int SetGoAlpha(GameObject go, int alphaType, float triggerTime = 0.03f, int cycleTimes = 30)
    {
        var meshs = ListPool<Renderer>.Get();
        var matList = ListPool<Material>.Get();
        go.GetComponentsInChildren(true, meshs);
        for (int i = 0; i < meshs.Count; i++)
        {
            var mats = meshs[i].materials;
            matList.AddRange(mats);
        }

        var alpha = 0f;
        var deltaAlpha = triggerTime;
        if (0 == alphaType)
        {
            deltaAlpha = triggerTime;
        }
        else
        {
            alpha = 1f;
            deltaAlpha = -triggerTime;
        }
        int timerId = TimerManager.Regist(triggerTime,
            (id) =>
            {
                alpha = alpha + deltaAlpha;
                alpha = Mathf.Min(alpha, 1);
                alpha = Mathf.Max(alpha, 0);

                for (int i = 0; i < matList.Count; ++i)
                {
                    var mat = matList[i];
                    if (alpha >= 0.999f)
                    {
                        mat.SetOverrideTag("RenderType", "Opaque");
                    }
                    else
                    {
                        mat.SetOverrideTag("RenderType", "Transparent");
                    }

                    mat.SetFloat("_Cutoff", alpha);
                }
            },
            cycleTimes);

        ListPool<Material>.Release(matList);
        ListPool<Renderer>.Release(meshs);
        return timerId;
    }

    public static void SetGoAlpha(GameObject go, float alpha = 1f)
    {
        go.GetComponentsInChildren(true, _tmpRendererList);
        for (int i = 0; i < _tmpRendererList.Count; ++i)
        {
            var renderer = _tmpRendererList[i];
            renderer.GetMaterials(_tmpMaterialList);
            for (int j = 0; j < _tmpMaterialList.Count; j++)
            {
                var mat = _tmpMaterialList[j];
                if (alpha >= 0.999f)
                {
                    // mat.SetOverrideTag("RenderType", "Opaque");
                    mat.SetInt("_BlendSrc", 1);
                    mat.SetInt("_BlendDrc", 0);
                    // mat.SetInt("_ZWrite", 1);
                }
                else
                {
                    // mat.SetOverrideTag("RenderType", "Transparent");
                    mat.SetInt("_BlendSrc", 5);
                    mat.SetInt("_BlendDrc", 10);
                    // mat.SetInt("_ZWrite", 0);
                }
                mat.SetFloat("_Cutoff", alpha);
            }
            _tmpMaterialList.Clear();
        }
        _tmpRendererList.Clear();
    }

    public static void SetRenderQueue(GameObject go, int queue = 0)
    {
        go.GetComponentsInChildren(true, _tmpRendererList);
        for (int i = 0; i < _tmpRendererList.Count; ++i)
        {
            var renderer = _tmpRendererList[i];
            renderer.GetMaterials(_tmpMaterialList);
            for (int j = 0; j < _tmpMaterialList.Count; j++)
            {
                var mat = _tmpMaterialList[j];
                if (queue == 0)
                {
                    mat.renderQueue = mat.shader.renderQueue;
                }
                else
                {
                    mat.renderQueue = queue;
                }
            }
            _tmpMaterialList.Clear();
        }
        _tmpRendererList.Clear();
    }

    public static void CancleSetGoAlpha(int timerId)
    {
        TimerManager.UnRegist(timerId);
    }

    public static void SetUIPosXY(RectTransform rt, float x, float y)
    {
        var pos = rt.anchoredPosition;
        pos.x = x;
        pos.y = y;
        rt.anchoredPosition = pos;
    }

    public static void SetPosXYZ(Transform t, float x, float y, float z)
    {
        var pos = t.position;
        pos.x = x;
        pos.y = y;
        pos.z = z;
        t.position = pos;
    }

    public static void SetPosXZ(Transform t, float x, float z)
    {
        var pos = t.position;
        pos.x = x;
        pos.z = z;
        t.position = pos;
    }

    public static void SetPosY(Transform t, float y)
    {
        var pos = t.position;
        pos.y = y;
        t.position = pos;
    }

    public static void SetLocalPosXYZ(Transform t, float x, float y, float z)
    {
        var pos = t.localPosition;
        pos.x = x;
        pos.y = y;
        pos.z = z;
        t.localPosition = pos;
    }

    public static void SetLocalPosXZ(Transform t, float x, float z)
    {
        var pos = t.localPosition;
        pos.x = x;
        pos.z = z;
        t.localPosition = pos;
    }

    public static void SetLocalPosY(Transform t, float y)
    {
        var pos = t.localPosition;
        pos.y = y;
        t.localPosition = pos;
    }

    public static void SetUISizeXY(RectTransform rt, float x, float y)
    {
        var size = rt.sizeDelta;
        size.x = x;
        size.y = y;
        rt.sizeDelta = size;
    }
    public static void SetUISizeX(RectTransform rt, float x)
    {
        var size = rt.sizeDelta;
        size.x = x;
        rt.sizeDelta = size;
    }

    public static void SetUISizeY(RectTransform rt, float y)
    {
        var size = rt.sizeDelta;
        size.y = y;
        rt.sizeDelta = size;
    }

    public static void SetUIAnchorMin(RectTransform rt, float x, float y)
    {
        var size = rt.anchorMin;
        size.x = x;
        size.y = y;
        rt.anchorMin = size;
    }

    public static void SetUIAnchorMax(RectTransform rt, float x, float y)
    {
        var size = rt.anchorMax;
        size.x = x;
        size.y = y;
        rt.anchorMax = size;
    }

    public static void SetUIPivot(RectTransform rt, float x, float y)
    {
        var size = rt.pivot;
        size.x = x;
        size.y = y;
        rt.pivot = size;
    }



    public static Component GetOrAddComponent(GameObject go, Type t)
    {
        var component = go.GetComponent(t);
        if (null == component)
            component = go.AddComponent(t);

        return component;
    }

    public static void RemoveComponent(GameObject go, Type t)
    {
        var component = go.GetComponent(t);
        if (null == component)
            return;

        GameObject.Destroy(component);
    }

    public static T GetOrAddComponent<T>(GameObject go) where T : Component
    {
        var component = go.GetComponent<T>();
        if (null == component)
            component = go.AddComponent<T>();

        return component;
    }

    public void RemoveComponent<T>(GameObject go) where T : Component
    {
        var component = go.GetComponent<T>();
        if (null == component)
            return;

        GameObject.Destroy(component);
    }

    public static void UIAddClickDown(GameObject go, Action<Vector2> action = null, int isBubble = 0, int isScale = 0)
    {
        var uiDragListener = GetOrAddComponent<UIDragListener>(go);
        uiDragListener.OnPointerDownEvent = action;
        uiDragListener.isBubble = isBubble == 1;
        uiDragListener.isScale = isScale == 1;
    }

    public static void UIAddClickUp(GameObject go, Action<Vector2> action = null, int isBubble = 0, int isScale = 0)
    {
        var uiDragListener = GetOrAddComponent<UIDragListener>(go);
        uiDragListener.OnPointerUpEvent = action;
        uiDragListener.isBubble = isBubble == 1;
        uiDragListener.isScale = isScale == 1;
    }

    public static void UIAddDrag(GameObject go, Action<Vector2> action = null, int isBubble = 0)
    {
        var uiDragListener = GetOrAddComponent<UIDragListener>(go);
        uiDragListener.OnDragEvent = action;
        uiDragListener.isBubble = isBubble == 1;
    }

    public static void UIAddDragData(GameObject go, Action<UnityEngine.EventSystems.PointerEventData> action = null)
    {
        var uiDragListener = GetOrAddComponent<UIDragListener>(go);
        uiDragListener.OnDragDataEvent = action;
    }

    public static void UIAddClick(GameObject go, Action<UnityEngine.EventSystems.PointerEventData> action = null, int isBubble = 0, int isScale = 0)
    {
        var uiDragListener = GetOrAddComponent<UIDragListener>(go);
        uiDragListener.OnClick = action;
        uiDragListener.isBubble = isBubble == 1;
        uiDragListener.isScale = isScale == 1;
    }

    public static void UIAddDoubleClick(GameObject go, Action<UnityEngine.EventSystems.PointerEventData> action = null, int isBubble = 0)
    {
        var uiDragListener = GetOrAddComponent<UIDragListener>(go);
        uiDragListener.OnDoubleClick = action;
        uiDragListener.isBubble = isBubble == 1;
    }

    public static void UIAddOnLongPress(GameObject go, Action action = null, float delay = 1, int isBubble = 0)
    {
        var uiDragListener = GetOrAddComponent<UIDragListener>(go);
        uiDragListener.OnLongPress = action;
        uiDragListener.isBubble = isBubble == 1;
        uiDragListener.durationThreshold = delay;
    }

    public static void UIAddPressOn(GameObject go, Action<float> action = null, int isBubble = 0, int isScale = 0)
    {
        var uiDragListener = GetOrAddComponent<UIDragListener>(go);
        uiDragListener.OnPressEvent = action;
        uiDragListener.isBubble = isBubble == 1;
        uiDragListener.isScale = isScale == 1;
        uiDragListener.isPressOn = true;
    }

    public static void UIAddScrollDrag(GameObject go, GameObject scrollGo, int scrollType = 1, Action<Vector2> action = null, int isBubble = 0)
    {
        var uiDragListener = GetOrAddComponent<UIDragListener>(go);
        uiDragListener.scrollType = (UIDragListener.ScrollType)scrollType;
        uiDragListener.ScrollViewGo = scrollGo;
        uiDragListener.OnScrollViewDragEvent = action;
        uiDragListener.isBubble = isBubble == 1;
    }

    public static void UIAddBeginDrag(GameObject go, Action<UnityEngine.EventSystems.PointerEventData> action = null, int isBubble = 0)
    {
        var uiDragListener = GetOrAddComponent<UIDragListener>(go);
        uiDragListener.OnBeginDragEvent = action;
        uiDragListener.isBubble = isBubble == 1;
    }

    public static void UIAddEndDrag(GameObject go, Action<UnityEngine.EventSystems.PointerEventData> action = null, int isBubble = 0)
    {
        var uiDragListener = GetOrAddComponent<UIDragListener>(go);
        uiDragListener.OnEndDragEvent = action;
        uiDragListener.isBubble = isBubble == 1;
    }

    public static void UIAddPointerEnter(GameObject go, Action<UnityEngine.EventSystems.PointerEventData> action = null, int isBubble = 0)
    {
        var uiDragListener = GetOrAddComponent<UIDragListener>(go);
        uiDragListener.OnPointEnterEvent = action;
        uiDragListener.isBubble = isBubble == 1;
    }

    public static void UIAddPointerExit(GameObject go, Action<UnityEngine.EventSystems.PointerEventData> action = null, int isBubble = 0)
    {
        var uiDragListener = GetOrAddComponent<UIDragListener>(go);
        uiDragListener.OnPointExitEvent = action;
        uiDragListener.isBubble = isBubble == 1;
    }

    public static UIButtonExtend UIAddButtonClick(GameObject go, Action<UnityEngine.EventSystems.PointerEventData> action = null, int isScale = 0, int isBubble = 0)
    {
        var button = GetOrAddComponent<UIButtonExtend>(go);
        button.OnClick = action;
        button.isBubble = isBubble == 1;
        button.isScale = isScale == 1;
        return button;
    }

    public static void UIAddLongPressButton(GameObject go, Action action = null, float interval = 1, int max = -1, int noFirst = 0, int isScale = 0, int isBubble = 0)
    {
        var button = GetOrAddComponent<UIButtonExtend>(go);
        button.SetLongPressAction(action, interval, max, noFirst == 1);
        button.isBubble = isBubble == 1;
        button.isScale = isScale == 1;
    }

    public static void UIAddLongPressButton2(GameObject go, Action action = null, float delay = 1, float interval = 1, int max = -1, int isScale = 0)
    {
        var button = GetOrAddComponent<UIButtonLongPress>(go);
        button.SetLongPressAction(action, delay, interval, max);
        button.isScale = isScale == 1;
    }

    public static int GetSystemLanguage()
    {
        return (int)Application.systemLanguage;
    }

    static List<Transform> _tmpTransformList = new List<Transform>();
    public static void SetLayer(GameObject go, int layer)
    {
        go.GetComponentsInChildren(true, _tmpTransformList);
        for (int i = 0; i < _tmpTransformList.Count; i++)
        {
            var t = _tmpTransformList[i];
            t.gameObject.layer = layer;
        }

        _tmpTransformList.Clear();
    }

    //设置TMPSetting
    public static void SetTMPDefaultSpriteAsset(TMP_SpriteAsset spriteAsset)
    {
        TMP_SpriteAsset setting = TMP_Settings.defaultSpriteAsset;
        setting.fallbackSpriteAssets.Clear();
        setting.fallbackSpriteAssets.AddRange(spriteAsset.fallbackSpriteAssets);
    }

    public static Component AddComponentOnce(GameObject go, Type type)
    {
        var com = go.GetComponent(type);
        if (null == com)
            com = go.AddComponent(type);

        return com;
    }

    public static void SetParentAndInit(Transform t, Transform tParent, int mask = 7)
    {
        t.SetParent(tParent, false);
        if ((mask & 1) == 1)
            t.localPosition = Vector3.zero;

        if ((mask & 2) == 2)
            t.localEulerAngles = Vector3.zero;

        if ((mask & 4) == 4)
            t.localScale = Vector3.one;
    }

    public static void SetParentAndRectInit(RectTransform t, RectTransform tParent, int mask = 15)
    {
        t.SetParent(tParent, false);
        if ((mask & 1) == 1)
            t.anchoredPosition3D = Vector3.zero;

        if ((mask & 2) == 2)
            t.offsetMin = Vector3.zero;

        if ((mask & 4) == 4)
            t.offsetMax = Vector3.one;

        if ((mask & 8) == 8)
            t.localScale = Vector3.one;
    }

    public static void OverrideAnimation(Animator animator, AnimationClip animationClip)
    {
        OverrideAnimation(animator, animationClip.name, animationClip);
    }

    public static void OverrideAnimation(Animator animator, AnimationClip srcClip, AnimationClip dstClip)
    {
        if (null == animator || null == srcClip)
            return;

        var runtimeAnimatorController = animator.runtimeAnimatorController;
        var animatorOverrideController = runtimeAnimatorController as AnimatorOverrideController;
        if (null == animatorOverrideController)
        {
            animatorOverrideController = new AnimatorOverrideController(runtimeAnimatorController);
            animatorOverrideController.name = runtimeAnimatorController.name;
            animator.runtimeAnimatorController = animatorOverrideController;
        }

        animatorOverrideController[srcClip] = dstClip;
    }

    public static void OverrideAnimation(Animator animator, string srcName, AnimationClip dstClip)
    {
        if (null == animator)
            return;
        var runtimeAnimatorController = animator.runtimeAnimatorController;
        var animatorOverrideController = runtimeAnimatorController as AnimatorOverrideController;
        if (null == animatorOverrideController)
        {
            animatorOverrideController = new AnimatorOverrideController(runtimeAnimatorController);
            animatorOverrideController.name = runtimeAnimatorController.name;
            animator.runtimeAnimatorController = animatorOverrideController;
        }
        animatorOverrideController[srcName] = dstClip;
    }

    public static void ClearOverrideAnimation(Animator animator)
    {
        if (null == animator)
            return;
        var runtimeAnimatorController = animator.runtimeAnimatorController;
        var animatorOverrideController = runtimeAnimatorController as AnimatorOverrideController;
        if (null == animatorOverrideController)
            return;
        animator.runtimeAnimatorController = animatorOverrideController.runtimeAnimatorController;
    }


    public static int IsNull(Object obj)
    {
        return null == obj ? 1 : 0;
    }

    public static int IsAnimationClipEmpty(AnimationClip clip)
    {
        if (null == clip)
            return 1;
        return clip.empty ? 1 : 0;
    }

    public static void SetEulerAngles(Transform t, float x, float y = 0, float z = 0)
    {
        t.eulerAngles = new Vector3(x, y, z);
    }

    public static void SetLocalEulerAngles(Transform t, float x, float y = 0, float z = 0)
    {
        t.localEulerAngles = new Vector3(x, y, z);
    }

    public static void SetEulerAnglesY(Transform t, float y)
    {
        var eulerAngles = t.eulerAngles;
        eulerAngles.y = y;
        t.eulerAngles = eulerAngles;
    }

    public static void SetLocalEulerAnglesY(Transform t, float y)
    {
        var localEulerAngles = t.localEulerAngles;
        localEulerAngles.y = y;
        t.localEulerAngles = localEulerAngles;
    }

    public static void SetScale(Transform t, float allScale)
    {
        var localScale = t.localScale;
        localScale.x = allScale;
        localScale.y = allScale;
        localScale.z = allScale;
        t.localScale = localScale;
    }

    public static void SetScaleXYZ(Transform t, float x, float y, float z)
    {
        var localScale = t.localScale;
        localScale.x = x;
        localScale.y = y;
        localScale.z = z;
        t.localScale = localScale;
    }

    static Vector3 _tmpV3;
    static RaycastHit _tmRaycastHit;
    static Vector3 VECTOR3_DOWN = Vector3.down;
    public static float DEFAULT_RAYCAST_Y_HEIGHT = 100f;
    public static int RaycastY(float x, float y, float z, out float raycastHitedY, float maxDistance = 200, int layerMask = 8)
    {
        _tmpV3.Set(x, y + DEFAULT_RAYCAST_Y_HEIGHT, z);
        if (Physics.Raycast(_tmpV3, VECTOR3_DOWN, out _tmRaycastHit, maxDistance, layerMask))
        {
            raycastHitedY = _tmRaycastHit.point.y;
            return 1;
        }
        else
        {
            raycastHitedY = 0;
            return 0;
        }
    }

    public static int RaycastYXZ(float x, float z, out float raycastHitedY, float maxDistance = 200, int layerMask = 8)
    {
        return RaycastY(x, 0, z, out raycastHitedY, maxDistance, layerMask);
    }

    public static int RaycastY(Transform t, out float raycastHitedY, float maxDistance = 200, int layerMask = 8)
    {
        var pos = t.position;
        return RaycastY(pos.x, pos.y, pos.z, out raycastHitedY, maxDistance, layerMask);
    }

    public static int RaycastYAndSet(Transform t, out float raycastHitedY, float maxDistance = 200, int layerMask = 8)
    {
        var pos = t.position;
        var iIsHited = RaycastY(pos.x, pos.y, pos.z, out raycastHitedY, maxDistance, layerMask);
        pos.y = raycastHitedY;
        t.position = pos;

        return iIsHited;
    }

    public static int _sortingOrderMax;
    public static void SetSortingOrder(GameObject go, int baseOrder)
    {
        _sortingOrderMax = -int.MaxValue;
        var sortingOrderOffset = int.MaxValue;

        go.GetComponentsInChildren(true, _tmpRendererList);
        for (int i = 0; i < _tmpRendererList.Count; ++i)
        {
            var renderer = _tmpRendererList[i];
            sortingOrderOffset = Math.Min(renderer.sortingOrder, sortingOrderOffset);
        }

        for (int i = 0; i < _tmpRendererList.Count; ++i)
        {
            var renderer = _tmpRendererList[i];
            var sortingOrder = renderer.sortingOrder - sortingOrderOffset;
            sortingOrder = baseOrder + sortingOrder;
            _sortingOrderMax = Math.Max(sortingOrder, _sortingOrderMax);
            renderer.sortingOrder = sortingOrder;
        }
        _tmpRendererList.Clear();
    }

    public static void SetSortingLayerName(GameObject go, string sortingLayerName)
    {
        go.GetComponentsInChildren(true, _tmpRendererList);
        for (int i = 0; i < _tmpRendererList.Count; ++i)
        {
            var renderer = _tmpRendererList[i];
            renderer.sortingLayerName = sortingLayerName;
        }
        _tmpRendererList.Clear();
    }

    public static void SetSortingLayerName(GameObject go, string sortingLayerName, int sortingOrder)
    {
        go.GetComponentsInChildren(true, _tmpRendererList);
        for (int i = 0; i < _tmpRendererList.Count; ++i)
        {
            var renderer = _tmpRendererList[i];
            renderer.sortingLayerName = sortingLayerName;
            renderer.sortingOrder = sortingOrder;
        }
        _tmpRendererList.Clear();
    }

    public static void SetSortingLayerId(GameObject go, int sortingLayerID)
    {
        go.GetComponentsInChildren(true, _tmpRendererList);

        for (int i = 0; i < _tmpRendererList.Count; ++i)
        {
            var renderer = _tmpRendererList[i];
            renderer.sortingLayerID = sortingLayerID;
        }

        _tmpRendererList.Clear();
    }

    public static void SetRendererActiveByTag(GameObject go, Dictionary<string, bool> tagActiveMap, int iIncludeInactive = 1)
    {
        go.GetComponentsInChildren<Renderer>(1 == iIncludeInactive, _tmpRendererList);
        for (int i = 0; i < _tmpRendererList.Count; i++)
        {
            var renderer = _tmpRendererList[i];
            var goChild = renderer.gameObject;
            var tag = goChild.tag;
            if (tagActiveMap.ContainsKey(tag))
            {
                var active = tagActiveMap[tag];
                goChild.SetActive(active);
            }
        }
        _tmpRendererList.Clear();
    }

    public static void SetRendererActiveByTag(GameObject go, string tag, int iIsActive, int iIncludeInactive = 1)
    {
        var isActive = 1 == iIsActive;
        go.GetComponentsInChildren<Renderer>(1 == iIncludeInactive, _tmpRendererList);
        for (int i = 0; i < _tmpRendererList.Count; i++)
        {
            var renderer = _tmpRendererList[i];
            if (renderer.gameObject.CompareTag(tag))
                renderer.gameObject.SetActive(isActive);
        }
        _tmpRendererList.Clear();
    }

    public static Dictionary<string, bool> ParseStringBoolMap(Dictionary<string, bool> map)
    {
        if (null == map)
            map = new Dictionary<string, bool>();

        return map;
    }

    public static Dictionary<int, bool> ParseIntBoolMap(Dictionary<int, bool> map)
    {
        if (null == map)
            map = new Dictionary<int, bool>();

        return map;
    }

    public static void SetRendererActiveByLayer(GameObject go, Dictionary<int, bool> layerActiveMap, int iIncludeInative = 1)
    {
        go.GetComponentsInChildren<Renderer>(1 == iIncludeInative, _tmpRendererList);
        for (int i = 0; i < _tmpRendererList.Count; i++)
        {
            var goChild = _tmpRendererList[i].gameObject;
            var layer = goChild.layer;
            if (layerActiveMap.ContainsKey(layer))
            {
                var active = layerActiveMap[layer];
                goChild.SetActive(active);
            }
        }
        _tmpRendererList.Clear();
    }

    public static void SetRendererActiveByLayer(GameObject go, int layer, int iIsActive, int iIncludeInative = 1)
    {
        var isActive = 1 == iIsActive;
        go.GetComponentsInChildren<Renderer>(1 == iIncludeInative, _tmpRendererList);
        for (int i = 0; i < _tmpRendererList.Count; i++)
        {
            var goChild = _tmpRendererList[i].gameObject;
            if (goChild.layer == layer)
                goChild.SetActive(isActive);
        }
        _tmpRendererList.Clear();
    }

    public static void SetShadowCasting(GameObject go, int active = 0)
    {
        go.GetComponentsInChildren<Renderer>(true, _tmpRendererList);
        for (int i = 0; i < _tmpRendererList.Count; i++)
        {
            _tmpRendererList[i].shadowCastingMode = (UnityEngine.Rendering.ShadowCastingMode)active;
        }
        _tmpRendererList.Clear();
    }

    public static void ReActiveGo(GameObject go)
    {
        go.SetActive(false);
        go.SetActive(true);
    }

    public static Texture GetTextureByByte(string base64Str, int width, int height)
    {
        byte[] bytes = Convert.FromBase64String(base64Str);
        Texture2D texture2D = new Texture2D(width, height);
        texture2D.LoadImage(bytes);
        //RuntimePlatform.WindowsEditor
        return texture2D;
    }

    public static void SetBehaviorEnabled(Behaviour behavior, int iEnabled = 1)
    {
        if (0 == iEnabled)
            behavior.enabled = false;
        else
            behavior.enabled = true;
    }

    private static List<ParticleSystem> _particleList = new List<ParticleSystem>();

    public static int GetParticleSystemCount(GameObject go, out int totalCount)
    {
        _particleList.Clear();
        go.GetComponentsInChildren<ParticleSystem>(_particleList);
        totalCount = _particleList.Count;
        int count = 0;
        for (int i = 0; i < _particleList.Count; i++)
        {
            if (_particleList[i].gameObject.activeInHierarchy)
            {
                count = count + 1;
            }
        }
        return count;
    }

    public static int GetParticleSystemParticleCount(GameObject go, out int totalCount)
    {
        _particleList.Clear();
        go.GetComponentsInChildren<ParticleSystem>(_particleList);
        int count = 0;
        totalCount = 0;
        for (int i = 0; i < _particleList.Count; i++)
        {
            if (_particleList[i].gameObject.activeInHierarchy)
            {
                count = count + _particleList[i].particleCount;
            }
            totalCount = totalCount + _particleList[i].particleCount;
        }
        return count;
    }

    public static Vector3 _tFarawayPos = new Vector3(100000, 100000, 100000);
    public static void SetTFaraway(Transform t)
    {
        t.position = _tFarawayPos;
    }

    public static string[] _str2TMPSpriteNumStr = new string[] {
        "<sprite={0}>",
        "<sprite={0}><sprite={1}>",
        "<sprite={0}><sprite={1}><sprite={2}>",
        "<sprite={0}><sprite={1}><sprite={2}><sprite={3}>",
        "<sprite={0}><sprite={1}><sprite={2}><sprite={3}><sprite={4}>",
        "<sprite={0}><sprite={1}><sprite={2}><sprite={3}><sprite={4}><sprite={5}>",
        "<sprite={0}><sprite={1}><sprite={2}><sprite={3}><sprite={4}><sprite={5}><sprite={6}>",
        "<sprite={0}><sprite={1}><sprite={2}><sprite={3}><sprite={4}><sprite={5}><sprite={6}><sprite={7}>",
        "<sprite={0}><sprite={1}><sprite={2}><sprite={3}><sprite={4}><sprite={5}><sprite={6}><sprite={7}><sprite={8}>",
        "<sprite={0}><sprite={1}><sprite={2}><sprite={3}><sprite={4}><sprite={5}><sprite={6}><sprite={7}><sprite={8}><sprite={9}>",
    };
    public static List<string> _spriteNumList = new List<string>(10);
    public static string[] _spriteNumArray = new string[10];
    public static Dictionary<int, string> _spriteNumStrCache = new Dictionary<int, string>();
    public static int _maxSpriteNumStrCacheCount = 100;
    public static int _curSpriteNumStrCacheCount = 0;
    public static string[] _num2StringArray = new string[]{
        "0",
        "1",
        "2",
        "3",
        "4",
        "5",
        "6",
        "7",
        "8",
        "9",
    };

    public static void ClearSpriteNumStrCache()
    {
        _spriteNumStrCache.Clear();
        _curSpriteNumStrCacheCount = 0;
    }

    public static void SetMaxSpriteNumStrCacheCount(int num)
    {
        _maxSpriteNumStrCacheCount = num;
    }

    public static int GetMaxSpriteNumStrCacheCount()
    {
        return _maxSpriteNumStrCacheCount;
    }

    public static string GetNumberToSpriteNumStr(int number)
    {
        if (number == 0)
        {
            _spriteNumArray[0] = "0";
            return string.Format(_str2TMPSpriteNumStr[0], _spriteNumArray);
        }
        number = Math.Abs(number);
        _spriteNumList.Clear();
        while (number > 0)
        {
            _spriteNumList.Add(_num2StringArray[number % 10]);
            number /= 10;
        }
        for (int i = 0; i < _spriteNumList.Count; i++)
            _spriteNumArray[i] = _spriteNumList[_spriteNumList.Count - i - 1];
        return string.Format(_str2TMPSpriteNumStr[_spriteNumList.Count - 1], _spriteNumArray); ;
    }

    public static string GetSpriteFontNumStr(int num)
    {
        string str;
        if (!_spriteNumStrCache.ContainsKey(num))
        {
            if (_curSpriteNumStrCacheCount > _maxSpriteNumStrCacheCount)
            {
                _curSpriteNumStrCacheCount = 0;
                _spriteNumStrCache.Clear();
            }
            str = GetNumberToSpriteNumStr(num);
            _curSpriteNumStrCacheCount++;
            _spriteNumStrCache.Add(num, str);
        }
        else
            str = _spriteNumStrCache[num];
        return str;
    }

    public static void SetTMPFontNum(TextMeshProUGUI tmp, int num)
    {
        tmp.text = GetSpriteFontNumStr(num);
    }

    public static void SetTMPFontNum(TextMeshPro tmp, int num)
    {
        tmp.text = GetSpriteFontNumStr(num);
    }

    public static void SetTMPFontNum(TMP_Text tmp, int num)
    {
        tmp.text = GetSpriteFontNumStr(num);
    }

    public static void Vibrate()
    {
#if !UNITY_WEBGL
        Handheld.Vibrate();
#endif
    }

    public static void InitBugly()
    {
        var main = Main.Instance;
        if (main)
            main.InitBugly();
    }

    public static Rect GetWXMenuButtonBoundingRect()
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        ClientRect crect = WeChatWASM.WX.GetMenuButtonBoundingClientRect();
        Rect rect = new Rect((float)crect.left, (float)crect.bottom, (float)crect.width, (float)crect.height);
        return rect;
#else
        Rect rect = new Rect(0, 0, 0, 0);
        return rect;
#endif
    }

    public static string GetWXWindowInfo()
    {
#if UNITY_WEBGL
        WindowInfo winInfo = WeChatWASM.WX.GetWindowInfo();
        return Newtonsoft.Json.JsonConvert.SerializeObject(winInfo);
#else
        return string.Empty;
#endif
    }


    public static string GetWXDeviceInfo()
    {
#if UNITY_WEBGL
        var deviceInfo = WeChatWASM.WX.GetDeviceInfo();
        return Newtonsoft.Json.JsonConvert.SerializeObject(deviceInfo);
#else
        return string.Empty;
#endif

    }

    private static Action<int> _luaWXSetKeepScreeCallback = null;

    public static void SetWXSetKeepScreenOn(Action<int> luaCallback = null, bool keepScreenOn = true)
    {
#if UNITY_WEBGL
        _luaWXSetKeepScreeCallback = luaCallback;
        SetKeepScreenOnOption callback = new SetKeepScreenOnOption();
        callback.keepScreenOn = keepScreenOn;
        callback.fail = (result) =>
        {
            if (_luaWXSetKeepScreeCallback != null)
                _luaWXSetKeepScreeCallback(0);
        };
        callback.success = (result) =>
        {
            if (_luaWXSetKeepScreeCallback != null)
                _luaWXSetKeepScreeCallback(1);
        };
        WeChatWASM.WX.SetKeepScreenOn(callback);
#endif
    }

    public static void EnsureMakeDir(string path)
    {
#if UNITY_WEBGL
        var fs = WX.GetFileSystemManager();
        string dirPath = string.Empty;
        int lastSlashIndex = path.LastIndexOf('/');
        if (lastSlashIndex != -1)
        {
            dirPath = path.Substring(0, lastSlashIndex);
            //Logger.Log("make dir path:" + path + "  dirpath:" + dirPath + " result:" + fs.AccessSync(dirPath));
            if (fs.AccessSync(dirPath).Equals("access:ok"))
                return;
            fs.MkdirSync(dirPath, true);
        }
#endif
    }

    public static string GetWXPersistentPath()
    {
#if UNITY_WEBGL
        return WX.env.USER_DATA_PATH;
#endif
        return string.Empty;
    }

    // 0.8.0
    public static BytesPacker CopyBytesPacker(UnityWebRequest unityWebRequest, BytesPacker bytesPacker = null)
    {
        if (null == bytesPacker)
            bytesPacker = new BytesPacker();

        bytesPacker._bs = unityWebRequest.downloadHandler.data;
        return bytesPacker;
    }

    // 0.8.0
    public static int Texture2DLoadImage(Texture2D t2d, BytesPacker bytesPacker, bool markNonReadable = false)
    {
        return t2d.LoadImage(bytesPacker._bs, markNonReadable) ? 1 : 0;
    }

    // 0.8.0
    public static void Texture2DLoadRawImage(Texture2D t2d, BytesPacker bytesPacker)
    {
        t2d.LoadRawTextureData(bytesPacker._bs);
    }

    // 0.8.0
    public static string ReadAllBytesByW3(string url, out byte[] bs, int millisecondsTimeout = 10)
    {
        WWW w3 = new WWW(url);
        while (!w3.isDone)
            Thread.Sleep(millisecondsTimeout);

        var err = w3.error;
        if (null == err)
            bs = w3.bytes;
        else
            bs = null;

        w3.Dispose();
        return err;
    }

    // 0.8.0
    // 安卓专用
    public static string ReadAllBytesPackerByW3(string url, BytesPacker bytesPacker = null, int millisecondsTimeout = 10)
    {
        if (null == bytesPacker)
            bytesPacker = new BytesPacker();

        var err = ReadAllBytesByW3(url, out bytesPacker._bs, millisecondsTimeout);
        return err;
    }

    // 0.8.0
    public static string BytesToBase64(byte[] bytes)
    {
        return Convert.ToBase64String(bytes);
    }
    // 0.8.0
    public static byte[] Base64ToBytes(string base64Str)
    {
        return Convert.FromBase64String(base64Str);
    }

    // 0.8.0
    public static byte[] GetFileBytes(string path)
    {
        return FileHelper.ReadBytes(path);
    }

    // 0.8.0
    public static uint GetCrc32Hash(byte[] data)
    {
        return Crc32.Calc(data);
    }

    public static uint GetTotalMemorySize()
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        uint totalMemory = WeChatWASM.WX.GetTotalMemorySize();
        Debug.Log($"当前总内存: {totalMemory / (1024f * 1024f)} MB");
        return totalMemory;
#else
        return 0;
#endif
    }

    public static uint GetStaticMemorySize()
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        uint staticMemory = WeChatWASM.WX.GetStaticMemorySize();
        Debug.Log($"当前Static总内存: {staticMemory / (1024f * 1024f)} MB");
        return staticMemory;
#else
        return 0;
#endif
    }
    public static uint GetDynamicMemorySize()
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        uint dynamicMemory = WeChatWASM.WX.GetDynamicMemorySize();
        Debug.Log($"当前UnityHeap动态内存: {dynamicMemory / (1024f * 1024f)}MB");
        return dynamicMemory;
#else
        return 0;
#endif
    }

    public static uint GetUsedMemorySize()
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        uint usedMemory = WeChatWASM.WX.GetUsedMemorySize();
        Debug.Log($"当前UnityHeap已使用动态内存: {usedMemory / (1024f * 1024f)}MB");
        return usedMemory;
#else
        return 0;
#endif
    }

    private static Action<int> _luaRrestartMiniProgramOptionCallback = null;
    /// <summary>
    /// 重启小程序
    /// </summary>
    public static void RestartMiniProgram(Action<int> luaCallback = null)
    {
#if UNITY_WEBGL
        var restartMiniProgramOption = new RestartMiniProgramOption();
        restartMiniProgramOption.fail = (result) =>
        {
            if (_luaRrestartMiniProgramOptionCallback != null)
                _luaRrestartMiniProgramOptionCallback(0);
        };
        restartMiniProgramOption.success = (result) =>
        {
            if (_luaRrestartMiniProgramOptionCallback != null)
                _luaRrestartMiniProgramOptionCallback(1);
        };
        WX.RestartMiniProgram(restartMiniProgramOption);
#endif
    }

    /// <summary>
    /// UpdateReStart
    /// </summary>
    public static void VersionUpdateRestartMiniProgram()
    {
#if UNITY_WEBGL
        var updateManager = WX.GetUpdateManager();
        updateManager.OnUpdateReady((result) => {
            // 新版本下载完成后重启
            updateManager.ApplyUpdate();
        });
#endif
    }
    //0.10.0才可以用
    public static void SetCameraRenderShadows(GameObject cameraGo, bool isShadows)
    {
        var cameraData = cameraGo.GetComponent<UniversalAdditionalCameraData>();
        if (cameraData != null)
            cameraData.renderShadows = isShadows;
    }

    public static WxApiButton RegistWXBtn(GameObject btn)
    {
#if UNITY_WEBGL
        var component = btn.GetComponent<WxApiButton>();
        if (null == component)
            component = btn.AddComponent<WxApiButton>();
        return component;
#endif
        return null;
    }


#if UNITY_WEBGL
    [DllImport("__Internal")]
    public static extern void GetCode();

    public static void WXGetCode()
    {
        GetCode();
    }

#endif
}