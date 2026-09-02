/**
 * Archetype library.
 *
 * The density gate can reject a thin spec but it cannot make one rich. That job
 * belongs here: each archetype tells the model how subjects of this kind are
 * actually decomposed, what moves, what gets measured, and what the legend
 * entries sound like. Without it a model asked for "a lathe" returns eight boxes
 * and no motion.
 *
 * Each entry carries four things:
 *
 *   guidance   the prose handed to the model, verbatim.
 *   demand     how much each evidence axis matters for this class, 0..1. This is
 *              what lets the sufficiency check know that a vessel described with
 *              nothing about its internals is badly under-evidenced, while a
 *              bracket in the same state is fine. The weights are read straight
 *              off the guidance above them — vessel's internals weight is 1.0
 *              because its own prose says a section view is mandatory.
 *   part /
 *   internal /
 *   motion     the vocabulary a competent description of this class would use.
 *              Evidence scoring counts how much of it the input actually
 *              supplies, which is a far better signal of "is this brief any
 *              good" than counting words. Chinese terms sit alongside the
 *              English because a brief in Chinese is evidence just as good.
 *
 * Adding a domain = adding an entry. Nothing else in the pipeline changes.
 */

/** The evidence axes a fine-grained drawing needs covered. */
export const AXES = ['identity', 'scale', 'decomposition', 'internals',
                     'kinematics', 'materials', 'geometry'];

export const ARCHETYPES = {

  vehicle: {
    guidance: `
SUBJECT CLASS: VEHICLE (tanks, trucks, trains, cars, plant machinery)
Decompose as: chassis/hull group; body panels; running gear (wheels or tracks,
  suspension arms, sprockets, idlers, rollers); powertrain covers and louvres;
  crew stations and hatches; lamps, mirrors, tow points; stowage.
Drivers to declare: speed (0..max, km/h), steer or slew, and one toggle per
  removable assembly (skirts, canopy, doors).
Motions: RUN (idle vibration + any slow scan), DRIVE (speed up, wheels spin,
  suspension oscillates), plus subject-specific one-shots, EXPLODE.
Channels: spin on every wheel/roller bound to speed; pathFollow for tracks or
  chains; oscillate on suspension bound to speed; articulate for doors/ramps.
Instruments: road speed, a rotational readout, a travel/deflection readout,
  a count (wheels, links, axles), refresh.
Dimensions: overall length, overall height, overall width — three at minimum.
Note voice: "Torsion-bar swing arm, ±180 mm travel", "Cast link, 196 mm pitch".`,

    demand: { identity: 1, scale: 1, decomposition: 1,
              internals: 0.8, kinematics: 1,
              materials: 0.6, geometry: 0.5 },

    part: [
      "hull", "chassis", "track", "sprocket", "idler", "roller", "suspension", "torsion",
      "swing arm", "turret", "hatch", "louvre", "glacis", "skirt", "axle", "wheel", "cab",
      "bogie", "车体", "底盘", "履带", "主动轮", "诱导轮", "负重轮", "悬挂", "扭杆", "炮塔", "舱盖", "百叶", "裙板", "车桥",
      "驾驶室",
    ],
    internal: [
      "powerpack", "power pack", "transmission", "engine", "gearbox", "magazine", "ammunition",
      "crew station", "fuel cell", "radiator", "driveshaft", "differential", "动力包", "变速箱",
      "发动机", "弹药", "乘员", "油箱", "散热器", "传动轴", "差速器",
    ],
    motion: [
      "traverse", "elevation", "slew", "recoil", "steer", "travel", "stroke", "top speed",
      "gradient", "回转", "俯仰", "后坐", "转向", "行程", "最大速度", "爬坡",
    ],
  },

  "rotating-machine": {
    guidance: `
SUBJECT CLASS: ROTATING MACHINE (engines, pumps, turbines, compressors, motors)
Decompose as: casing split into sections; rotor/shaft; impeller or cylinder
  set (use radial or linear instances); bearings and housings; valve or port
  gear; drive and accessory train; mounts and isolators; fluid volumes.
Drivers: rpm, a crank/phase accumulator with a very large max for spin phase,
  a flow or pressure driver, plus toggles for covers.
Motions: IDLE and RUN as a mutually exclusive group, a momentary PRIME/START,
  a flow toggle, a cover toggle, EXPLODE.
Channels: spin on shaft and rotor bound to rpm; reciprocate with "spread":"auto"
  for piston or plunger sets so instances phase apart correctly; flow along pipe
  paths; emit at exhaust or vent points.
Instruments: speed, a derived linear velocity, a pressure, a count, refresh.
Note voice: "Nitrided steel, 146 mm bore, 22 cooling fins", "Dry sump, 26 L/min".`,

    demand: { identity: 1, scale: 0.8, decomposition: 1,
              internals: 1, kinematics: 1,
              materials: 0.7, geometry: 0.5 },

    part: [
      "casing", "housing", "rotor", "stator", "shaft", "impeller", "cylinder", "head",
      "bearing", "seal", "valve", "manifold", "cowl", "flange", "crankcase", "fin", "机壳", "壳体",
      "转子", "定子", "叶轮", "气缸", "缸盖", "轴承", "密封", "气门", "歧管", "整流罩", "法兰", "曲轴箱", "散热片",
    ],
    internal: [
      "crankshaft", "camshaft", "piston", "conrod", "connecting rod", "gear train",
      "oil gallery", "combustion chamber", "vane", "diffuser", "曲轴", "凸轮轴", "活塞", "连杆", "齿轮系",
      "油道", "燃烧室", "导叶", "扩压器",
    ],
    motion: [
      "rpm", "stroke", "bore", "displacement", "flow", "head", "pressure ratio", "tip speed",
      "转速", "行程", "缸径", "排量", "流量", "扬程", "压比",
    ],
  },

  mechanism: {
    guidance: `
SUBJECT CLASS: MECHANISM (linkages, robots, presses, gearboxes, actuators)
Decompose as: frame; each link as its own part parented in the kinematic chain;
  joints called out explicitly; drive element; end effector; guards; fasteners.
Drivers: one per degree of freedom, normalised 0..1 where it reads as travel.
Motions: one per pose or cycle stage, plus a continuous CYCLE, EXPLODE.
Channels: articulate for every joint, parented so the chain composes; spin for
  gears with ratios expressed in the bind (e.g. "drive * -2.5"); impulse for a
  press stroke or a latch.
Instruments: joint angles, stroke position, cycle rate, reach, refresh.
Note voice: "Hardened pin, 20 mm, needle roller bushed".`,

    demand: { identity: 0.7, scale: 0.8, decomposition: 1,
              internals: 0.6, kinematics: 1,
              materials: 0.6, geometry: 0.7 },

    part: [
      "link", "linkage", "joint", "pin", "bushing", "frame", "guard", "end effector",
      "gripper", "cam", "follower", "rack", "pinion", "lead screw", "actuator", "连杆", "关节",
      "衬套", "机架", "护罩", "末端", "夹爪", "凸轮", "齿条", "齿轮", "丝杠", "作动器",
    ],
    internal: [
      "gear train", "ratio", "bearing pack", "clutch", "brake", "encoder", "ballscrew", "齿轮系",
      "速比", "轴承", "离合器", "制动", "编码器", "滚珠丝杠",
    ],
    motion: [
      "degree of freedom", "dof", "stroke", "reach", "payload", "cycle", "travel", "angle",
      "自由度", "行程", "工作半径", "负载", "节拍", "转角",
    ],
  },

  structure: {
    guidance: `
SUBJECT CLASS: STRUCTURE (buildings, bridges, towers, frames, enclosures)
Decompose as: foundation/base; primary frame (columns, beams — use grid
  instances); floor plates; envelope panels and glazing; roof; circulation
  (stairs, lifts); services; railings and balustrades.
Materials matter more here than anywhere: concrete, masonry, metal, glass,
  timber, insulation and earth should all appear.
Drivers: an occupancy or load driver, a daylight/opening driver, apart.
Motions: a reveal that hides the envelope, an opening toggle, EXPLODE by storey.
Channels: visibility on envelope groups; articulate for doors/louvres;
  explode with vertical separation vectors so storeys lift apart in order.
Instruments: gross area, height, storey count, span, occupancy, refresh.
Dimensions: overall height, span, bay spacing. Include at least one section.
Note voice: "S355 UB 610x229, 140 kg/m, 9 m clear span".`,

    demand: { identity: 0.7, scale: 1, decomposition: 1,
              internals: 0.5, kinematics: 0.3,
              materials: 1, geometry: 0.8 },

    part: [
      "foundation", "column", "beam", "girder", "truss", "slab", "deck", "facade", "cladding",
      "glazing", "roof", "stair", "core", "bracing", "pile", "基础", "桁架", "楼板", "幕墙", "围护",
      "玻璃", "屋面", "楼梯", "核心筒", "支撑",
    ],
    internal: [
      "riser", "duct", "service core", "plant room", "reinforcement", "rebar", "post-tension",
      "管井", "风管", "设备层", "配筋", "钢筋", "预应力",
    ],
    motion: [
      "live load", "deflection", "sway", "settlement", "occupancy", "活载", "挠度", "位移", "沉降",
    ],
  },

  appliance: {
    guidance: `
SUBJECT CLASS: APPLIANCE / CONSUMER DEVICE (kitchen machines, tools, printers)
Decompose as: outer housing split into real mouldings; chassis; motor and drive;
  the working element; a reservoir or hopper; user controls; display; feet;
  cable or hose. Show fasteners and vents — they carry the density.
Drivers: power level, a fill/level driver, a lid or door driver.
Motions: ON at low and high settings (mutually exclusive group), OPEN, EXPLODE.
Channels: spin on the motor and working element; emit for steam or dust;
  articulate for the lid; oscillate for vibration bound to power.
Instruments: speed, power draw, temperature or level, capacity, refresh.
Note voice: "ABS moulding, 2.5 mm wall, ultrasonic welded".`,

    demand: { identity: 0.9, scale: 0.8, decomposition: 1,
              internals: 0.9, kinematics: 0.7,
              materials: 0.7, geometry: 0.5 },

    part: [
      "housing", "chassis", "panel", "lid", "door", "control", "display", "knob", "vent",
      "foot", "hose", "cord", "filter", "tank", "外壳", "机身", "面板", "控制", "显示", "旋钮", "出风", "软管",
      "电源线", "滤网", "水箱",
    ],
    internal: [
      "motor", "pump", "heating element", "impeller", "gearbox", "pcb", "board", "reservoir",
      "compressor", "电机", "水泵", "发热", "叶轮", "齿轮箱", "电路板", "储液", "压缩机",
    ],
    motion: [
      "speed", "setting", "power", "rpm", "cycle", "capacity", "flow", "档位", "功率", "转速", "程序",
      "容量", "流量",
    ],
  },

  vessel: {
    guidance: `
SUBJECT CLASS: VESSEL / CONTAINER (tanks, boilers, reactors, bottles, cookware)
Decompose as: shell (lathe or loft); heads and closures; nozzles and flanges;
  internals (baffles, coils, agitator); supports and saddles; insulation and
  cladding as separate parts; instrumentation tappings; the contained fluid.
The fluid must be its own part with material "liquid" and a level channel.
Drivers: level, temperature, pressure, agitator speed.
Motions: FILL, DRAIN, STIR, EXPLODE.
Channels: scale.y or pos.y on the fluid bound to level; spin on agitators;
  emit at vents; flow along pipe runs.
Instruments: level, volume, pressure, temperature, refresh.
A section view is mandatory — a vessel's whole point is what is inside it.
Note voice: "316L shell, 8 mm, 6 bar design, PED Cat III".`,

    demand: { identity: 0.8, scale: 1, decomposition: 0.9,
              internals: 1, kinematics: 0.5,
              materials: 1, geometry: 0.6 },

    part: [
      "shell", "head", "nozzle", "flange", "manway", "saddle", "skirt", "support",
      "insulation", "cladding", "jacket", "筒体", "封头", "接管", "法兰", "人孔", "鞍座", "裙座", "支座", "保温",
      "夹套",
    ],
    internal: [
      "baffle", "coil", "agitator", "impeller", "tray", "packing", "demister", "sparger",
      "internals", "liquid level", "折流板", "盘管", "搅拌", "叶轮", "塔盘", "填料", "除沫", "分布器", "内件",
      "液位",
    ],
    motion: [
      "fill", "drain", "stir", "agitation", "rpm", "residence", "flow", "level", "进料", "排放",
      "搅拌", "转速", "停留", "流量", "液位",
    ],
  },

  aircraft: {
    guidance: `
SUBJECT CLASS: AIRCRAFT (aeroplanes, helicopters, drones, spacecraft)
Decompose as: fuselage (loft through stations); wing or rotor set; control
  surfaces as separate hinged parts; empennage; powerplant and intakes;
  landing gear with retraction; canopy and glazing; antennas and probes.
Drivers: throttle, a control-surface deflection driver, gear position, rotor phase.
Motions: an engine run, CONTROLS sweep, GEAR up/down, EXPLODE.
Channels: articulate for every control surface and gear leg (parented so bogies
  follow legs); spin for rotors and fans; oscillate for flex bound to throttle.
Instruments: thrust or rpm, deflection angles, span, mass, refresh.
Note voice: "Two-spar wet wing, 7075-T6, 4° washout".`,

    demand: { identity: 1, scale: 1, decomposition: 1,
              internals: 0.7, kinematics: 1,
              materials: 0.7, geometry: 0.6 },

    part: [
      "fuselage", "wing", "spar", "rib", "empennage", "stabiliser", "stabilizer", "aileron",
      "elevator", "rudder", "flap", "nacelle", "intake", "landing gear", "canopy", "rotor",
      "pylon", "机身", "机翼", "翼梁", "翼肋", "尾翼", "安定面", "副翼", "升降舵", "方向舵", "襟翼", "短舱", "进气",
      "起落架", "座舱盖", "旋翼", "挂架",
    ],
    internal: [
      "fuel tank", "wet wing", "avionics", "bulkhead", "former", "actuator", "gearbox",
      "engine core", "油箱", "整体油箱", "航电", "隔框", "作动器", "减速器", "核心机",
    ],
    motion: [
      "deflection", "throttle", "rpm", "retraction", "sweep", "incidence", "washout", "cruise",
      "偏度", "油门", "转速", "收放", "后掠", "安装角", "扭转", "巡航",
    ],
  },

  instrument: {
    guidance: `
SUBJECT CLASS: INSTRUMENT (watches, meters, optics, lab and measuring equipment)
Work in small units — mm or µm — and set bounds accordingly.
Decompose as: case and bezel; crystal or window; movement plates; gear train
  (each wheel its own part with a real tooth count in the note); escapement;
  power source; hands, pointers or scales; jewels and screws.
Density here comes from the gear train and from screws: use boltCircle,
  fastener and perforation liberally.
Drivers: a time or measurement driver, a winding driver.
Motions: RUN, WIND, a momentary reset, EXPLODE, plus a movement reveal.
Channels: spin on every wheel with the correct ratio in the bind; articulate for
  levers; visibility to lift the dial off the movement.
Instruments: rate, amplitude, reserve, jewel count, refresh.
Note voice: "Escape wheel, 15 teeth, 21 600 A/h".`,

    demand: { identity: 0.9, scale: 1, decomposition: 1,
              internals: 1, kinematics: 0.9,
              materials: 0.6, geometry: 0.5 },

    part: [
      "case", "bezel", "crystal", "dial", "hand", "pointer", "scale", "lens", "objective",
      "eyepiece", "plate", "bridge", "表壳", "表圈", "镜面", "表盘", "指针", "刻度", "镜片", "物镜", "目镜",
      "夹板", "夹桥",
    ],
    internal: [
      "movement", "escapement", "balance", "mainspring", "barrel", "gear train", "wheel",
      "jewel", "pallet", "sensor", "coil", "机芯", "擒纵", "摆轮", "发条", "条盒", "轮系", "齿轮", "宝石",
      "擒纵叉", "传感器", "线圈",
    ],
    motion: [
      "beat", "amplitude", "frequency", "reserve", "tolerance", "vph", "hz", "rate", "摆频",
      "摆幅", "频率", "动力储存", "走时", "振次",
    ],
  },

  generic: {
    guidance: `
SUBJECT CLASS: GENERIC
No archetype matched cleanly, so build from first principles:
identify the structural core, the enclosure, the moving elements, the
interfaces, and the consumables. Give every part a real engineering note.
At minimum the page needs: something that rotates or translates, one toggle
that removes an outer layer, an exploded view, a section, three dimensions
and six instrument rows.`,

    demand: { identity: 0.8, scale: 1, decomposition: 1,
              internals: 0.7, kinematics: 0.8,
              materials: 0.7, geometry: 0.5 },

    part: [
      "frame", "housing", "panel", "cover", "mount", "bracket", "fastener", "interface",
      "port", "base", "骨架", "外壳", "面板", "盖板", "安装", "支架", "紧固", "接口", "端口", "底座",
    ],
    internal: [
      "internal", "inside", "interior", "core", "cavity", "chamber", "assembly", "内部", "内腔",
      "腔", "总成",
    ],
    motion: [
      "speed", "stroke", "travel", "cycle", "rate", "angle", "速度", "行程", "位移", "周期", "转角",
    ],
  },
};

/**
 * Cheap keyword router used when the caller doesn't name an archetype.
 *
 * Latin terms are matched on word boundaries; CJK terms cannot be, because `\b`
 * is defined against [A-Za-z0-9_] and never fires between two Han characters.
 * Hence two patterns per class rather than one.
 */
const ROUTES = [
  ['vehicle',          /\b(tank|truck|car|lorry|train|locomotive|tractor|excavator|bulldozer|bus|van|motorcycle|chassis)\b/,
                       /(坦克|汽车|卡车|火车|机车|装甲车|挖掘机|拖拉机|底盘)/],
  ['rotating-machine', /\b(engine|motor|pump|turbine|compressor|generator|fan|blower|rotor|crankshaft)\b/,
                       /(发动机|引擎|电机|水泵|涡轮|压缩机|风机|曲轴|转子)/],
  ['aircraft',         /\b(aircraft|aeroplane|airplane|helicopter|drone|rocket|spacecraft|satellite|fuselage)\b/,
                       /(飞机|直升机|无人机|火箭|航天器|卫星|机身)/],
  ['structure',        /\b(building|bridge|tower|hangar|warehouse|truss|stadium|scaffold|storey)\b/,
                       /(建筑|桥梁|桥|塔|厂房|仓库|桁架|体育场|脚手架)/],
  ['vessel',           /\b(boiler|reactor|silo|kettle|bottle|pressure vessel|autoclave|tundish)\b/,
                       /(容器|锅炉|反应器|反应釜|储罐|罐|压力容器)/],
  ['instrument',       /\b(watch|clock|movement|microscope|telescope|gauge|caliper|escapement|chronograph)\b/,
                       /(手表|钟表|钟|机芯|显微镜|望远镜|仪表|卡尺|游标)/],
  ['mechanism',        /\b(linkage|gearbox|robot|manipulator|press|actuator|clamp|jig|mechanism|cam)\b/,
                       /(机构|连杆|齿轮箱|减速机|机器人|机械臂|夹具|凸轮|压力机)/],
  ['appliance',        /\b(printer|blender|toaster|vacuum|mixer|drill|appliance|espresso|coffee|dishwasher)\b/,
                       /(家电|打印机|搅拌机|烤箱|吸尘器|咖啡机|洗碗机|电钻)/],
];

export function guessArchetype(text = '') {
  const t = String(text).toLowerCase();
  for (const [name, latin, cjk] of ROUTES) {
    if (latin.test(t) || cjk.test(t)) return name;
  }
  return 'generic';
}

export function archetypeGuidance(name) {
  return (ARCHETYPES[name] ?? ARCHETYPES.generic).guidance;
}
