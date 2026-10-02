// ApercuPont : le jeu Unity en direct dans le panneau Aperçu de Claude Code.
//
// Adaptateur du protocole Aperçu, sens entrant (voir PROTOCOLE.md) : il pousse
// l'écran du jeu au hub, avec en repères les contrôles UGUI visibles et en
// journal les erreurs Unity, et il exécute les gestes qu'il reçoit (toucher,
// taper, touches, défiler).
//
// Installation : copier ce fichier dans Assets/Apercu/, et écrire
// Assets/Apercu/Resources/apercu.txt avec trois lignes :
//   l'URL du hub vue depuis la machine du jeu (http://127.0.0.1:7357 avec un pont SSH)
//   le jeton de la cible
//   le nom de la cible dans .apercu.json (« jeu » par défaut)
// Les variables d'environnement APERCU_HUB, APERCU_TOKEN et APERCU_NOM passent avant.
// Il démarre seul, dans l'éditeur et dans les builds de développement uniquement.
//
// Les jeux qui lisent l'input directement (Input.GetMouseButtonDown, actions du
// nouvel Input System) ne voient pas un clic UGUI : abonne-toi à TapSansUI
// pour le leur transmettre (souris virtuelle, appel à ton contrôleur…).

using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using System.Text;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.Networking;
using UnityEngine.SceneManagement;
using UnityEngine.UI;

public class ApercuPont : MonoBehaviour
{
    /// Un toucher qui ne tombe sur aucun élément d'UI, en coordonnées écran Unity (origine en bas).
    public static event Action<Vector2> TapSansUI;

    const float Fps = 4f;
    const int MaxSide = 1280;

    string hub, token, nom;
    readonly Dictionary<string, Selectable> byId = new Dictionary<string, Selectable>();
    readonly List<LogItem> logs = new List<LogItem>();
    uint lastHash;
    string lastHints = "";

    [Serializable] class HintItem { public float x, y, w, h, cx, cy; public string label, kind, id; }
    [Serializable] class LogItem { public string kind, text; }
    [Serializable] class Push { public string jpeg; public int w, h; public HintItem[] hints; public string url; public LogItem[] logs; }
    [Serializable] class Act { public int id; public string type, @ref, text, key, url; public float x, y, dy; public int n; }
    [Serializable] class Pull { public bool ok; public Act[] actions; }
    [Serializable] class Done { public int id; public bool ok; public string text, error; }

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    static void Boot()
    {
        if (!Application.isEditor && !Debug.isDebugBuild) return;
        var go = new GameObject("ApercuPont");
        DontDestroyOnLoad(go);
        go.hideFlags = HideFlags.HideInHierarchy;
        go.AddComponent<ApercuPont>();
    }

    void Awake()
    {
        var lines = (Resources.Load<TextAsset>("apercu")?.text ?? "").Split('\n');
        string Line(int i) => i < lines.Length ? lines[i].Trim() : "";
        hub = (Environment.GetEnvironmentVariable("APERCU_HUB") ?? Line(0)).TrimEnd('/');
        token = Environment.GetEnvironmentVariable("APERCU_TOKEN") ?? Line(1);
        nom = Environment.GetEnvironmentVariable("APERCU_NOM") ?? (Line(2) != "" ? Line(2) : "jeu");
        if (hub == "" || token == "")
        {
            Debug.Log("ApercuPont : pas de hub configuré (Resources/apercu.txt ou APERCU_HUB et APERCU_TOKEN), rien n'est envoyé.");
            enabled = false;
            return;
        }
        Application.logMessageReceived += OnLog;
        StartCoroutine(PushLoop());
        StartCoroutine(PullLoop());
    }

    void OnDestroy() => Application.logMessageReceived -= OnLog;

    void OnLog(string text, string stack, LogType type)
    {
        if (type == LogType.Log) return;
        var kind = type == LogType.Warning ? "warning" : "erreur";
        var line = type == LogType.Exception ? $"{text}\n{FirstLines(stack, 3)}" : text;
        lock (logs) { logs.Add(new LogItem { kind = kind, text = line }); if (logs.Count > 40) logs.RemoveAt(0); }
    }

    static string FirstLines(string s, int n)
    {
        var parts = (s ?? "").Split('\n');
        return string.Join("\n", parts, 0, Math.Min(n, parts.Length));
    }

    string Url(string end) => $"{hub}/pont/{UnityWebRequest.EscapeURL(nom)}/{end}";

    UnityWebRequest Request(string end, string method, string json)
    {
        var req = new UnityWebRequest(Url(end), method) { downloadHandler = new DownloadHandlerBuffer() };
        if (json != null)
        {
            req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(json));
            req.SetRequestHeader("Content-Type", "application/json");
        }
        req.SetRequestHeader("Authorization", "Bearer " + token);
        return req;
    }

    // ───────────── image et repères ─────────────

    IEnumerator PushLoop()
    {
        var wait = new WaitForEndOfFrame();
        while (true)
        {
            yield return new WaitForSecondsRealtime(1f / Fps);
            yield return wait;
            byte[] jpg = Capture();
            var hints = ScanHints();
            var hintsJson = JsonUtility.ToJson(new Push { hints = hints });
            uint hash = Fnv(jpg);
            LogItem[] pending;
            lock (logs) { pending = logs.ToArray(); logs.Clear(); }
            if (hash == lastHash && hintsJson == lastHints && pending.Length == 0) continue;
            lastHash = hash;
            lastHints = hintsJson;
            var body = JsonUtility.ToJson(new Push
            {
                jpeg = Convert.ToBase64String(jpg),
                w = Screen.width,
                h = Screen.height,
                hints = hints,
                url = "unity://" + SceneManager.GetActiveScene().name,
                logs = pending,
            });
            using (var req = Request("push", "POST", body))
            {
                req.timeout = 10;
                yield return req.SendWebRequest();
                if (req.result != UnityWebRequest.Result.Success) yield return new WaitForSecondsRealtime(2f);
            }
        }
    }

    static byte[] Capture()
    {
        var shot = ScreenCapture.CaptureScreenshotAsTexture();
        int w = shot.width, h = shot.height;
        float k = Mathf.Min(1f, (float)MaxSide / Mathf.Max(w, h));
        Texture2D small = shot;
        if (k < 1f)
        {
            int sw = Mathf.RoundToInt(w * k), sh = Mathf.RoundToInt(h * k);
            var rt = RenderTexture.GetTemporary(sw, sh, 0);
            Graphics.Blit(shot, rt);
            var prev = RenderTexture.active;
            RenderTexture.active = rt;
            small = new Texture2D(sw, sh, TextureFormat.RGB24, false);
            small.ReadPixels(new Rect(0, 0, sw, sh), 0, 0);
            small.Apply();
            RenderTexture.active = prev;
            RenderTexture.ReleaseTemporary(rt);
            Destroy(shot);
        }
        var jpg = small.EncodeToJPG(70);
        Destroy(small);
        return jpg;
    }

    static uint Fnv(byte[] data)
    {
        uint h = 2166136261;
        for (int i = 0; i < data.Length; i += 7) h = (h ^ data[i]) * 16777619;
        return h ^ (uint)data.Length;
    }

    HintItem[] ScanHints()
    {
        byId.Clear();
        var list = new List<HintItem>();
#if UNITY_2023_1_OR_NEWER
        var all = FindObjectsByType<Selectable>(FindObjectsSortMode.None);
#else
        var all = FindObjectsOfType<Selectable>();
#endif
        var corners = new Vector3[4];
        foreach (var s in all)
        {
            if (!s.isActiveAndEnabled || !s.IsInteractable()) continue;
            var rt = s.transform as RectTransform;
            var canvas = s.GetComponentInParent<Canvas>();
            if (rt == null || canvas == null || !canvas.isActiveAndEnabled) continue;
            var cam = canvas.renderMode == RenderMode.ScreenSpaceOverlay ? null : canvas.worldCamera;
            rt.GetWorldCorners(corners);
            Vector2 a = RectTransformUtility.WorldToScreenPoint(cam, corners[0]);
            Vector2 b = RectTransformUtility.WorldToScreenPoint(cam, corners[2]);
            float x = Mathf.Min(a.x, b.x), w = Mathf.Abs(b.x - a.x);
            float yTop = Screen.height - Mathf.Max(a.y, b.y), h = Mathf.Abs(b.y - a.y);
            if (w < 4 || h < 4 || x > Screen.width || x + w < 0 || yTop > Screen.height || yTop + h < 0) continue;
            if (!IsOnTop(s.gameObject, new Vector2(x + w / 2, Screen.height - (yTop + h / 2)))) continue;
            var id = PathOf(s.transform);
            byId[id] = s;
            list.Add(new HintItem
            {
                x = x, y = yTop, w = w, h = h, cx = x + w / 2, cy = yTop + h / 2,
                label = LabelOf(s), kind = KindOf(s), id = id,
            });
            if (list.Count >= 80) break;
        }
        return list.ToArray();
    }

    static bool IsOnTop(GameObject go, Vector2 screenPos)
    {
        var es = EventSystem.current;
        if (es == null) return true;
        var hits = new List<RaycastResult>();
        es.RaycastAll(new PointerEventData(es) { position = screenPos }, hits);
        if (hits.Count == 0) return true;
        var top = hits[0].gameObject.transform;
        return top == go.transform || top.IsChildOf(go.transform);
    }

    static string PathOf(Transform t)
    {
        var sb = new StringBuilder(t.name);
        for (var p = t.parent; p != null; p = p.parent) sb.Insert(0, p.name + "/");
        return sb.ToString();
    }

    static readonly Type TmpText = Type.GetType("TMPro.TMP_Text, Unity.TextMeshPro");
    static readonly Type TmpInput = Type.GetType("TMPro.TMP_InputField, Unity.TextMeshPro");
    static readonly Type TmpDropdown = Type.GetType("TMPro.TMP_Dropdown, Unity.TextMeshPro");

    static string LabelOf(Selectable s)
    {
        string text = null;
        if (s is InputField f) text = f.text != "" ? f.text : (f.placeholder as Text)?.text;
        else if (TmpInput != null && TmpInput.IsInstanceOfType(s)) text = Prop(s, "text");
        if (string.IsNullOrEmpty(text) && TmpText != null)
        {
            var t = s.GetComponentInChildren(TmpText);
            if (t != null) text = Prop(t, "text");
        }
        if (string.IsNullOrEmpty(text)) text = s.GetComponentInChildren<Text>()?.text;
        if (string.IsNullOrEmpty(text)) text = s.name;
        text = text.Replace('\n', ' ').Trim();
        return text.Length > 40 ? text.Substring(0, 40) : text;
    }

    static string KindOf(Selectable s)
    {
        if (s is InputField || (TmpInput != null && TmpInput.IsInstanceOfType(s))) return "champ";
        if (s is Dropdown || (TmpDropdown != null && TmpDropdown.IsInstanceOfType(s))) return "liste";
        return "bouton";
    }

    static string Prop(object o, string name) =>
        o.GetType().GetProperty(name, BindingFlags.Public | BindingFlags.Instance)?.GetValue(o) as string;

    static void SetProp(object o, string name, string value) =>
        o.GetType().GetProperty(name, BindingFlags.Public | BindingFlags.Instance)?.SetValue(o, value);

    // ───────────── gestes ─────────────

    IEnumerator PullLoop()
    {
        while (true)
        {
            using (var req = Request("pull?wait=20", "GET", null))
            {
                req.timeout = 30;
                yield return req.SendWebRequest();
                if (req.result != UnityWebRequest.Result.Success)
                {
                    yield return new WaitForSecondsRealtime(3f);
                    continue;
                }
                var pull = JsonUtility.FromJson<Pull>(req.downloadHandler.text);
                foreach (var a in pull?.actions ?? new Act[0])
                {
                    var done = new Done { id = a.id, ok = true };
                    try { done.text = Run(a); }
                    catch (Exception e) { done.ok = false; done.error = e.Message; }
                    using (var r = Request("done", "POST", JsonUtility.ToJson(done)))
                        yield return r.SendWebRequest();
                }
            }
        }
    }

    string Run(Act a)
    {
        var es = EventSystem.current;
        switch (a.type)
        {
            case "tap":
            {
                var pos = new Vector2(a.x, Screen.height - a.y);
                var go = es != null ? RaycastTop(es, pos) : null;
                if (go == null)
                {
                    TapSansUI?.Invoke(pos);
                    return $"touché ({(int)a.x}, {(int)a.y}), hors UI";
                }
                Click(es, go, pos);
                return $"touché « {go.name} »";
            }
            case "hint":
            {
                if (a.@ref == null || !byId.TryGetValue(a.@ref, out var s) || s == null)
                    return Run(new Act { type = "tap", x = a.x, y = a.y });
                Click(es, s.gameObject, new Vector2(a.x, Screen.height - a.y));
                var label = LabelOf(s);
                if (!string.IsNullOrEmpty(a.text)) { SetText(s.gameObject, a.text, replace: true); return $"rempli « {label} » avec « {a.text} »"; }
                return $"touché « {label} »";
            }
            case "type":
            {
                var go = es?.currentSelectedGameObject;
                if (go == null || !SetText(go, a.text ?? "", replace: false)) throw new Exception("aucun champ sélectionné");
                return $"tapé « {a.text} »";
            }
            case "key":
                return Key(es, (a.key ?? "").ToLowerInvariant());
            case "scroll":
            {
                if (es == null) throw new Exception("pas d'EventSystem");
                var pos = new Vector2(Screen.width / 2f, Screen.height / 2f);
                var go = RaycastTop(es, pos);
                if (go == null) throw new Exception("rien à faire défiler au centre");
                var ped = new PointerEventData(es) { position = pos, scrollDelta = new Vector2(0, -a.dy / 20f) };
                ExecuteEvents.ExecuteHierarchy(go, ped, ExecuteEvents.scrollHandler);
                return a.dy > 0 ? "défilé vers le bas" : "défilé vers le haut";
            }
            default:
                throw new Exception($"action non gérée par ApercuPont : {a.type}");
        }
    }

    static GameObject RaycastTop(EventSystem es, Vector2 pos)
    {
        var hits = new List<RaycastResult>();
        es.RaycastAll(new PointerEventData(es) { position = pos }, hits);
        return hits.Count > 0 ? hits[0].gameObject : null;
    }

    static void Click(EventSystem es, GameObject go, Vector2 pos)
    {
        if (es == null) throw new Exception("pas d'EventSystem dans la scène");
        var ped = new PointerEventData(es) { position = pos, button = PointerEventData.InputButton.Left, clickCount = 1 };
        var target = ExecuteEvents.GetEventHandler<IPointerClickHandler>(go) ?? go;
        ped.pointerPress = target;
        ped.rawPointerPress = go;
        ExecuteEvents.ExecuteHierarchy(go, ped, ExecuteEvents.pointerDownHandler);
        ExecuteEvents.ExecuteHierarchy(go, ped, ExecuteEvents.pointerUpHandler);
        ExecuteEvents.Execute(target, ped, ExecuteEvents.pointerClickHandler);
        var sel = target.GetComponent<Selectable>();
        if (sel != null) es.SetSelectedGameObject(sel.gameObject);
    }

    static bool SetText(GameObject go, string text, bool replace)
    {
        var f = go.GetComponent<InputField>();
        if (f != null) { f.text = replace ? text : f.text + text; f.MoveTextEnd(false); return true; }
        if (TmpInput != null)
        {
            var t = go.GetComponent(TmpInput);
            if (t != null) { SetProp(t, "text", replace ? text : Prop(t, "text") + text); return true; }
        }
        return false;
    }

    static string Key(EventSystem es, string key)
    {
        var go = es?.currentSelectedGameObject;
        switch (key)
        {
            case "enter":
                if (go == null) throw new Exception("rien de sélectionné");
                ExecuteEvents.Execute(go, new BaseEventData(es), ExecuteEvents.submitHandler);
                var f = go.GetComponent<InputField>();
                if (f != null) f.onEndEdit.Invoke(f.text);
                if (TmpInput != null && go.GetComponent(TmpInput) is Component t)
                {
                    var ev = TmpInput.GetField("onSubmit")?.GetValue(t);
                    ev?.GetType().GetMethod("Invoke")?.Invoke(ev, new object[] { Prop(t, "text") });
                }
                return "touche Entrée";
            case "escape":
                if (es != null) es.SetSelectedGameObject(null);
                if (go != null) ExecuteEvents.Execute(go, new BaseEventData(es), ExecuteEvents.cancelHandler);
                return "touche Échap";
            case "tab":
            {
                var next = go?.GetComponent<Selectable>()?.FindSelectableOnDown() ?? go?.GetComponent<Selectable>()?.FindSelectableOnRight();
                if (next == null) throw new Exception("pas d'élément suivant");
                es.SetSelectedGameObject(next.gameObject);
                return $"passé à « {next.name} »";
            }
            case "backspace":
            {
                if (go == null) throw new Exception("aucun champ sélectionné");
                var fi = go.GetComponent<InputField>();
                if (fi != null && fi.text.Length > 0) { fi.text = fi.text.Substring(0, fi.text.Length - 1); return "effacé"; }
                if (TmpInput != null && go.GetComponent(TmpInput) is Component tc)
                {
                    var s = Prop(tc, "text") ?? "";
                    if (s.Length > 0) SetProp(tc, "text", s.Substring(0, s.Length - 1));
                    return "effacé";
                }
                throw new Exception("aucun champ sélectionné");
            }
            case "arrowup": case "arrowdown": case "arrowleft": case "arrowright":
            {
                var dir = key == "arrowup" ? MoveDirection.Up : key == "arrowdown" ? MoveDirection.Down : key == "arrowleft" ? MoveDirection.Left : MoveDirection.Right;
                if (go == null) throw new Exception("rien de sélectionné");
                ExecuteEvents.Execute(go, new AxisEventData(es) { moveDir = dir }, ExecuteEvents.moveHandler);
                return $"flèche {key.Substring(5)}";
            }
            default:
                throw new Exception($"touche non gérée : {key}");
        }
    }
}
