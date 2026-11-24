/**
 * Known asset owners and service types, with the names and abbreviations they appear under
 * in layer names and object data. Used to guess what each utility is; the user can always correct it.
 */

export interface OwnerEntry {
  /** Display name. */
  name: string;
  /** Other spellings / abbreviations (matched case-insensitively, as whole words). */
  aliases: string[];
  /** Service type to assume when the owner only runs one kind of asset. */
  impliesType?: string;
}

export const OWNERS: OwnerEntry[] = [
  { name: 'Metro Trains Melbourne', aliases: ['MTM', 'METRO', 'METRO TRAINS', 'METRO TRAINS MELBOURNE'] },
  { name: 'VicTrack', aliases: ['VICTRACK', 'VIC TRACK', 'VT'] },
  { name: 'V/Line', aliases: ['VLINE', 'V/LINE', 'V LINE'] },
  { name: 'Telstra', aliases: ['TELSTRA', 'TLS'], impliesType: 'Comms' },
  { name: 'NBN Co', aliases: ['NBN', 'NBNCO', 'NBN CO'], impliesType: 'Comms' },
  { name: 'Optus', aliases: ['OPTUS'], impliesType: 'Comms' },
  { name: 'TPG', aliases: ['TPG', 'VOCUS', 'AAPT', 'NEXTGEN'], impliesType: 'Comms' },
  { name: 'Multinet Gas', aliases: ['MULTINET', 'MULTINET GAS', 'MGN'], impliesType: 'Gas' },
  { name: 'APA', aliases: ['APA', 'APA GROUP'], impliesType: 'Gas' },
  { name: 'Australian Gas Networks', aliases: ['AGN', 'AUSTRALIAN GAS NETWORKS', 'ENVESTRA'], impliesType: 'Gas' },
  { name: 'AusNet Services', aliases: ['AUSNET', 'AUSNET SERVICES', 'SPAUSNET'] },
  { name: 'United Energy', aliases: ['UE', 'UNITED ENERGY'], impliesType: 'Elec' },
  { name: 'CitiPower', aliases: ['CITIPOWER', 'CP'], impliesType: 'Elec' },
  { name: 'Powercor', aliases: ['POWERCOR', 'PCOR'], impliesType: 'Elec' },
  { name: 'Jemena', aliases: ['JEMENA', 'JEN'] },
  { name: 'Zinfra', aliases: ['ZINFRA'] },
  { name: 'South East Water', aliases: ['SEW', 'SOUTH EAST WATER'] },
  { name: 'Yarra Valley Water', aliases: ['YVW', 'YARRA VALLEY WATER'] },
  { name: 'Greater Western Water', aliases: ['GWW', 'GREATER WESTERN WATER', 'CWW', 'CITY WEST WATER', 'WW', 'WESTERN WATER'] },
  { name: 'Melbourne Water', aliases: ['MW', 'MELBOURNE WATER', 'MELB WATER'] },
  { name: 'Council', aliases: ['COUNCIL', 'LGA'] },
  { name: 'Department of Transport and Planning', aliases: ['DTP', 'VICROADS', 'DOT'] },
];

export interface TypeEntry {
  name: string;
  /** Whole-word keywords. */
  keywords: string[];
}

/** Service types in the wording used on markups (e.g. "Elec", "Comms"). Order matters: first match wins. */
export const SERVICE_TYPES: TypeEntry[] = [
  { name: 'Signalling', keywords: ['SIGNAL', 'SIGNALS', 'SIGNALLING', 'SIGNALING', 'SIG', 'CSR', 'TRACK CIRCUIT'] },
  { name: 'Traction power', keywords: ['TRACTION', 'TRACTION POWER', 'OHLE', 'CATENARY', 'CONTACT WIRE'] },
  { name: 'Comms', keywords: ['COMMS', 'COMM', 'COMMUNICATIONS', 'COMMUNICATION', 'TELECOM', 'TELECOMS', 'TELCO', 'FIBRE', 'FIBER', 'FOC', 'OPTIC', 'TEL'] },
  { name: 'Elec', keywords: ['ELEC', 'ELECTRIC', 'ELECTRICAL', 'ELECTRICITY', 'POWER', 'HV', 'LV', 'EHV', 'HVLV'] },
  { name: 'Lighting', keywords: ['LIGHTING', 'LIGHT', 'STREETLIGHT', 'STREETLIGHTING', 'PUBLIC LIGHTING', 'LIGHTS'] },
  { name: 'Gas', keywords: ['GAS', 'HPGAS', 'LPGAS'] },
  { name: 'Water', keywords: ['WATER', 'POTABLE', 'WATERMAIN', 'WTR', 'RECYCLED', 'FIRE', 'HYDRANT'] },
  { name: 'Sewer', keywords: ['SEWER', 'SEWERAGE', 'SEWAGE', 'SANITARY', 'SAN', 'RISING MAIN'] },
  { name: 'Drainage', keywords: ['DRAIN', 'DRAINAGE', 'STORMWATER', 'STORM', 'SW', 'SWD', 'CULVERT'] },
  { name: 'Fuel', keywords: ['FUEL', 'OIL', 'PETROLEUM', 'PIPELINE'] },
  { name: 'Rail', keywords: ['RAIL', 'TRACK', 'TRACKS', 'SLEEPER', 'BALLAST'] },
];

/** Words in layer names that mean an overhead service. */
export const OVERHEAD_KEYWORDS = ['OH', 'O/H', 'OHD', 'OVERHEAD', 'AERIAL', 'OHW', 'OHLE', 'CATENARY', 'CONTACT WIRE'];

/** Data field / attribute names that hold each kind of information (upper-cased, punctuation removed). */
export const OWNER_FIELDS = ['OWNER', 'ASSETOWNER', 'UTILITYOWNER', 'AUTHORITY', 'ASSETAUTHORITY', 'OPERATOR', 'NETWORKOWNER', 'UTILITYPROVIDER', 'PROVIDER'];
export const TYPE_FIELDS = ['SERVICE', 'SERVICETYPE', 'UTILITY', 'UTILITYTYPE', 'ASSETTYPE', 'TYPE', 'NETWORK', 'NETWORKTYPE'];
export const QL_FIELDS = ['QL', 'QUALITYLEVEL', 'QUALITY', 'QLEVEL', 'ASQL'];
export const DESCRIPTION_FIELDS = ['SIZE', 'DIAMETER', 'DIA', 'MATERIAL', 'DESCRIPTION', 'DESC', 'CONFIGURATION', 'CABLES'];
export const RL_FIELDS = ['RL', 'LEVEL', 'RLTOP', 'TOPRL', 'RLTOPOFSERVICE', 'TOP', 'TOS', 'RLOBVERT', 'OBVERT', 'RLLID', 'RLINVERT', 'INVERT', 'IL', 'ELEVATION', 'Z'];
