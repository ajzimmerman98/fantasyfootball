// ESPN league in the shape lm-api-reads returns for view=mSettings&view=mTeam&view=mRoster
const P=(id,first,last,pos,pro,inj)=>({id,firstName:first,lastName:last,fullName:`${first} ${last}`,defaultPositionId:pos,proTeamId:pro,injuryStatus:inj||"ACTIVE"});
const E=(p,slot,inj)=>({playerId:p.id,lineupSlotId:slot,injuryStatus:inj||"ACTIVE",playerPoolEntry:{player:p}});
const SWID="{ABCD-1234}";
export const league={id:1126044,seasonId:2026,scoringPeriodId:9,status:{currentMatchupPeriod:9},
 settings:{name:"Office League",rosterSettings:{lineupSlotCounts:{"0":1,"1":0,"2":2,"3":0,"4":2,"5":0,"6":1,"7":0,"16":1,"17":1,"20":6,"21":1,"23":1}},
  scoringSettings:{scoringItems:[{statId:53,points:0.5},{statId:42,points:0.1}]}},
 members:[{id:SWID,displayName:"aj98"},{id:"{OTHER-1}",displayName:"rival"}],
 teams:[
  {id:1,name:"AJ Squad",owners:[SWID],roster:{entries:[
    E(P(3918298,"Josh","Allen",1,2),0),E(P(1,"Lamar","Jackson",1,33),20),
    E(P(2,"Jahmyr","Gibbs",2,8),2),E(P(3,"Saquon","Barkley",2,21),2),E(P(4,"Breece","Hall",2,20),20),
    E(P(5,"Ja'Marr","Chase",3,4),4),E(P(6,"Puka","Nacua",3,14),20),E(P(7,"DK","Metcalf",3,23),4),
    E(P(8,"Trey","McBride",4,22),6),E(P(9,"Tucker","Kraft",4,9),23),
    E(P(10,"Brandon","Aubrey",5,6),17),E({id:-16030,firstName:"Jaguars",lastName:"D/ST",fullName:"Jaguars D/ST",defaultPositionId:16,proTeamId:30},16),
    E(P(11,"Some","Linebacker",11,6),20),E(P(12,"Hurt","Guy",3,2,"OUT"),21,"OUT")]}},
  {id:2,location:"Rival",nickname:"FC",owners:["{OTHER-1}"],roster:{entries:[
    E(P(20,"Drake","Maye",1,17),0),E(P(21,"Bijan","Robinson",2,1),2),E(P(22,"Kenneth","Walker III",2,12),2),E(P(23,"Derrick","Henry",2,33),20),E(P(24,"James","Cook III",2,2),20),
    E(P(25,"Jaxon","Smith-Njigba",3,26),4),E(P(26,"CeeDee","Lamb",3,6),4),E(P(27,"Brock","Bowers",4,13),6),E(P(28,"Zay","Flowers",3,33),23)]}}]};
