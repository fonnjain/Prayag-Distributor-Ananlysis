import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide57() {
  return (
    <Frame number={57} section="Product Tour">
      <SectionTitle eyebrow="SYSTEM" title="Users & Access Control" subtitle="Role-based permissions." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Granular permission scopes</Bullet>
          <Bullet>Auto-filtered by employee hierarchy</Bullet>
          <Bullet>Activity and audit logging</Bullet>
          <Bullet>Secure authentication flow</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex flex-col gap-[1.5vh]">
           <div className="flex justify-between items-center border-b border-[#a9b7c2]/20 pb-[1vh]">
             <div className="text-[1.5vw] text-[#f5f2ea]">Admin</div>
             <div className="text-[1.5vw] text-[#4ccfa3]">Full System Access</div>
           </div>
           <div className="flex justify-between items-center border-b border-[#a9b7c2]/20 pb-[1vh]">
             <div className="text-[1.5vw] text-[#f5f2ea]">State Head</div>
             <div className="text-[1.5vw] text-[#a9b7c2]">Regional Data Only</div>
           </div>
           <div className="flex justify-between items-center border-b border-[#a9b7c2]/20 pb-[1vh]">
             <div className="text-[1.5vw] text-[#f5f2ea]">Sales Rep</div>
             <div className="text-[1.5vw] text-[#a9b7c2]">Own Territory Only</div>
           </div>
        </div>
      </div>
    </Frame>
  );
}
