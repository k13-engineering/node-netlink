#include <node.h>
#include <nan.h>
#include <node_object_wrap.h>

#include <sys/types.h>
#include <sys/socket.h>

#include <linux/netlink.h>
#include <linux/rtnetlink.h>

#include <uv.h>
#include <unistd.h>

static void alloc_cb(uv_handle_t* handle, size_t suggested_size, uv_buf_t* buf) {
  buf->base = (char*) malloc(suggested_size);
  buf->len = suggested_size;
}

class NetlinkSocket : public node::ObjectWrap {
 public:
  static void Init(v8::Local<v8::Object> exports);

 private:
  explicit NetlinkSocket(v8::Isolate* isolate, int family, int pid, v8::Local<v8::Function> listener);
  ~NetlinkSocket();

  static void New(const v8::FunctionCallbackInfo<v8::Value>& args);
  static void Send(const v8::FunctionCallbackInfo<v8::Value>& args);
  static void Close(const v8::FunctionCallbackInfo<v8::Value>& args);
  static v8::Persistent<v8::Function> constructor;

  static void onRecv(uv_udp_t* handle, ssize_t nread, const uv_buf_t* buf, const struct sockaddr* addr, unsigned flags);
  static void onSent(uv_udp_send_t* req, int status);

  int fd;
  uint32_t nl_pid;
  uv_udp_t udp_handle;
  v8::Global<v8::Function> listener;
};

v8::Persistent<v8::Function> NetlinkSocket::constructor;

NetlinkSocket::NetlinkSocket(v8::Isolate* isolate, int family, int pid, v8::Local<v8::Function> listener) {
  fd = socket(AF_NETLINK, SOCK_DGRAM | SOCK_NONBLOCK, family);
  if(fd < 0) {
    isolate->ThrowException(v8::Exception::Error(v8::String::NewFromUtf8(isolate, "failed to create socket")));
    return;
  }
  
  struct sockaddr_nl src_addr;
  memset(&src_addr, 0, sizeof(src_addr));
  src_addr.nl_family = AF_NETLINK;
  src_addr.nl_pid = pid;
  src_addr.nl_groups = 0;
  
  int res;
  
  res = bind(fd, (struct sockaddr*) &src_addr, sizeof(src_addr));
  if(res < 0) {
    close(fd);
    isolate->ThrowException(v8::Exception::Error(v8::String::NewFromUtf8(isolate, "failed to bind socket")));
    return;
  }
  
  if(src_addr.nl_pid == 0) {
    socklen_t length = sizeof(src_addr);
    
    struct sockaddr_nl act_addr;
    
    res = getsockname(fd, (struct sockaddr*) &act_addr, &length);
    if(res < 0) {
      close(fd);
      isolate->ThrowException(v8::Exception::Error(v8::String::NewFromUtf8(isolate, "failed to get assigned socket address")));
      return;
    }
    
    nl_pid = act_addr.nl_pid;
  } else {
    nl_pid = src_addr.nl_pid;
  }
  
  res = uv_udp_init(uv_default_loop(), &udp_handle);
  if(res != 0) {
    close(fd);
    isolate->ThrowException(v8::Exception::Error(v8::String::NewFromUtf8(isolate, "failed to init udp handle")));
    return;
  }
  
  uv_handle_set_data((uv_handle_t*) &udp_handle, this);
  
  res = uv_udp_open(&udp_handle, fd);
  if(res != 0) {
    close(fd);
    isolate->ThrowException(v8::Exception::Error(v8::String::NewFromUtf8(isolate, "failed to create udp handle")));
    return;
  }
  
  res = uv_udp_recv_start(&udp_handle, alloc_cb, NetlinkSocket::onRecv);
  if(res != 0) {
    close(fd);
    isolate->ThrowException(v8::Exception::Error(v8::String::NewFromUtf8(isolate, "failed to start udp receive")));
    return;
  }
  
  this->listener = v8::Global<v8::Function>(isolate, listener);
}

NetlinkSocket::~NetlinkSocket() {
}

void NetlinkSocket::Init(v8::Local<v8::Object> exports) {
  v8::Isolate* isolate = exports->GetIsolate();

  v8::Local<v8::FunctionTemplate> tpl = v8::FunctionTemplate::New(isolate, New);
  tpl->SetClassName(v8::String::NewFromUtf8(isolate, "NetlinkSocket"));
  tpl->InstanceTemplate()->SetInternalFieldCount(1);

  NODE_SET_PROTOTYPE_METHOD(tpl, "send", Send);
  NODE_SET_PROTOTYPE_METHOD(tpl, "close", Close);

  constructor.Reset(isolate, tpl->GetFunction());
  exports->Set(v8::String::NewFromUtf8(isolate, "NetlinkSocket"),
               tpl->GetFunction());
}

void NetlinkSocket::New(const v8::FunctionCallbackInfo<v8::Value>& args) {
  v8::Isolate* isolate = args.GetIsolate();

  if (args.IsConstructCall()) {
    int family = args[0]->IsUndefined() ? 0 : args[0]->Int32Value();
    int pid = args[1]->IsUndefined() ? 0 : args[1]->Int32Value();
    v8::Local<v8::Function> listener = v8::Local<v8::Function>::Cast(args[1]);
    NetlinkSocket* obj = new NetlinkSocket(isolate, family, pid, listener);
    obj->Wrap(args.This());
    args.GetReturnValue().Set(args.This());
  } else {
    const int argc = 1;
    v8::Local<v8::Value> argv[argc] = { args[0] };
    v8::Local<v8::Context> context = isolate->GetCurrentContext();
    v8::Local<v8::Function> cons = v8::Local<v8::Function>::New(isolate, constructor);
    v8::Local<v8::Object> result =
        cons->NewInstance(context, argc, argv).ToLocalChecked();
    args.GetReturnValue().Set(result);
  }
}

struct send_work_data {
  v8::Isolate* isolate;
  v8::Global<v8::Context> ctx;
  v8::Global<v8::Function> cb;
  
  uint8_t* buf;
  size_t len;
};

void NetlinkSocket::onRecv(uv_udp_t* handle, ssize_t nread, const uv_buf_t* buf, const struct sockaddr* addr, unsigned flags) {  
  NetlinkSocket* socket = reinterpret_cast<NetlinkSocket*>(uv_handle_get_data((uv_handle_t*) handle));
  
  int len;
  struct nlmsghdr *nh;

  int part_count = 0;

  len = nread;
  for (nh = (struct nlmsghdr *) buf->base; NLMSG_OK (nh, len);
     nh = NLMSG_NEXT (nh, len)) {
    part_count += 1;
  }
  
  v8::Isolate* isolate = v8::Isolate::GetCurrent();
  v8::HandleScope scope(isolate);

  auto result = v8::Array::New(isolate);

  int idx = 0;
  len = nread;
  for (nh = (struct nlmsghdr *) buf->base; NLMSG_OK (nh, len);
     nh = NLMSG_NEXT (nh, len)) {

    auto part = v8::Object::New(isolate);

    auto header = v8::Object::New(isolate);
    header->Set(v8::String::NewFromUtf8(isolate, "nlmsg_len"), v8::Integer::New(isolate, nh->nlmsg_len));
    header->Set(v8::String::NewFromUtf8(isolate, "nlmsg_type"), v8::Integer::New(isolate, nh->nlmsg_type));
    header->Set(v8::String::NewFromUtf8(isolate, "nlmsg_flags"), v8::Integer::New(isolate, nh->nlmsg_flags));
    header->Set(v8::String::NewFromUtf8(isolate, "nlmsg_seq"), v8::Integer::New(isolate, nh->nlmsg_seq));
    header->Set(v8::String::NewFromUtf8(isolate, "nlmsg_pid"), v8::Integer::New(isolate, nh->nlmsg_pid));

    auto payload = Nan::CopyBuffer((const char*) NLMSG_DATA(nh), NLMSG_PAYLOAD(nh, 0)).ToLocalChecked();

    part->Set(v8::String::NewFromUtf8(isolate, "header"), header);
    part->Set(v8::String::NewFromUtf8(isolate, "payload"), payload);

    result->Set(idx, part);
    idx += 1;
  }

  v8::Local<v8::Value> argv[] = { result };
  
  v8::Local<v8::Object> dummy = v8::Object::New(isolate);
  v8::Local<v8::Function> cb = v8::Local<v8::Function>::New(isolate, socket->listener);
  
  Nan::AsyncResource("netlink:recv").runInAsyncScope(dummy, cb, 1, argv);
}

void NetlinkSocket::onSent(uv_udp_send_t* req, int status) {
  struct send_work_data* data = reinterpret_cast<struct send_work_data*>(uv_handle_get_data((uv_handle_t*) req));
  
  v8::Isolate* isolate = v8::Isolate::GetCurrent();

  v8::HandleScope scope(isolate);

  v8::Local<v8::Value> argv[] = { v8::Integer::New(isolate, status) };

  v8::Local<v8::Function> cb = v8::Local<v8::Function>::New(isolate, data->cb);

  v8::Local<v8::Object> dummy = v8::Object::New(isolate);
  Nan::AsyncResource("netlink:send").runInAsyncScope(dummy, cb, 1, argv);
  
  delete data->buf;
  delete data;
  delete req;
}

extern "C" int uv__udp_send(uv_udp_send_t* req,
                 uv_udp_t* handle,
                 const uv_buf_t bufs[],
                 unsigned int nbufs,
                 const struct sockaddr* addr,
                 unsigned int addrlen,
                 uv_udp_send_cb send_cb);

void NetlinkSocket::Send(const v8::FunctionCallbackInfo<v8::Value>& args) {
  v8::Isolate* isolate = args.GetIsolate();

  NetlinkSocket* obj = ObjectWrap::Unwrap<NetlinkSocket>(args.Holder());

  struct nlmsghdr hdr;
  memset(&hdr, 0, sizeof(hdr));
  
  v8::Local<v8::Function> hdl = v8::Local<v8::Function>::Cast(args[3]);
  
  auto header = args[0]->ToObject();
  auto nlmsg_len = header->Get(v8::String::NewFromUtf8(isolate, "nlmsg_len"));
  auto nlmsg_type = header->Get(v8::String::NewFromUtf8(isolate, "nlmsg_type"));
  auto nlmsg_flags = header->Get(v8::String::NewFromUtf8(isolate, "nlmsg_flags"));
  auto nlmsg_seq = header->Get(v8::String::NewFromUtf8(isolate, "nlmsg_seq"));
  auto nlmsg_pid = header->Get(v8::String::NewFromUtf8(isolate, "nlmsg_pid"));
  
  if(!nlmsg_len->IsUndefined()) {
    isolate->ThrowException(v8::Exception::Error(v8::String::NewFromUtf8(isolate, "nlmsg_len cannot be set as it is generated")));
    return;
  }
  
  if(nlmsg_type->IsUndefined()) {      
    isolate->ThrowException(v8::Exception::Error(v8::String::NewFromUtf8(isolate, "nlmsg_type is mandatory in header")));
    return;
  } else if(!nlmsg_type->IsUint32()) {
    isolate->ThrowException(v8::Exception::Error(v8::String::NewFromUtf8(isolate, "nlmsg_type must be an unsigned integer")));
    return;
  } else {
    auto value = nlmsg_type->ToUint32(isolate->GetCurrentContext()).ToLocalChecked()->Value();
    if(value > 0xFFFF) {
      isolate->ThrowException(v8::Exception::Error(v8::String::NewFromUtf8(isolate, "nlmsg_type must not exceed 16 bit range")));
      return;
    }
    hdr.nlmsg_type = value;
  }
  
  if(nlmsg_flags->IsUndefined()) {      
    hdr.nlmsg_flags = 0;
  } else if(!nlmsg_flags->IsUint32()) {
    isolate->ThrowException(v8::Exception::Error(v8::String::NewFromUtf8(isolate, "nlmsg_flags must be an unsigned integer")));
    return;
  } else {
    auto value = nlmsg_flags->ToUint32(isolate->GetCurrentContext()).ToLocalChecked()->Value();
    if(value > 0xFFFF) {
      isolate->ThrowException(v8::Exception::Error(v8::String::NewFromUtf8(isolate, "nlmsg_flags must not exceed 16 bit range")));
      return;
    }
    hdr.nlmsg_flags = value;
  }
  
  if(nlmsg_seq->IsUndefined()) {      
    isolate->ThrowException(v8::Exception::Error(v8::String::NewFromUtf8(isolate, "nlmsg_seq is mandatory in header")));
    return;
  } else if(!nlmsg_seq->IsUint32()) {
    isolate->ThrowException(v8::Exception::Error(v8::String::NewFromUtf8(isolate, "nlmsg_seq must be an unsigned integer")));
    return;
  } else {
    auto value = nlmsg_seq->ToUint32(isolate->GetCurrentContext()).ToLocalChecked()->Value();
    if(value > 0xFFFFFFFF) {
      isolate->ThrowException(v8::Exception::Error(v8::String::NewFromUtf8(isolate, "nlmsg_seq must not exceed 32 bit range")));
      return;
    }
    hdr.nlmsg_seq = value;
  }
  
  if(nlmsg_flags->IsUndefined()) {      
    hdr.nlmsg_pid = obj->nl_pid;
  } else if(!nlmsg_flags->IsUint32()) {
    isolate->ThrowException(v8::Exception::Error(v8::String::NewFromUtf8(isolate, "nlmsg_flags must be an unsigned integer")));
    return;
  } else {
    auto value = nlmsg_pid->ToUint32(isolate->GetCurrentContext()).ToLocalChecked()->Value();
    if(value > 0xFFFFFFFF) {
      isolate->ThrowException(v8::Exception::Error(v8::String::NewFromUtf8(isolate, "nlmsg_flags must not exceed 32 bit range")));
      return;
    }
    hdr.nlmsg_pid = value;
  }
  
  uv_udp_send_t* send_req = new uv_udp_send_t();
  memset(send_req, 0, sizeof(uv_udp_send_t));
  
  struct sockaddr_nl dst_addr;
  memset(&dst_addr, 0, sizeof(dst_addr));
  dst_addr.nl_family = AF_NETLINK;
  dst_addr.nl_pid = 0;
  dst_addr.nl_groups = 0;
  
  v8::Local<v8::Object> payload = v8::Local<v8::Object>::Cast(args[1]);
  
  hdr.nlmsg_len = NLMSG_LENGTH(node::Buffer::Length(payload));
  
  struct send_work_data* data = new send_work_data();
  data->len = sizeof(hdr) + node::Buffer::Length(payload);
  data->buf = new uint8_t[data->len];
  memcpy(data->buf + 0, &hdr, sizeof(hdr));
  memcpy(data->buf + sizeof(hdr), node::Buffer::Data(payload), node::Buffer::Length(payload));
  
  uv_buf_t bufs[1];
  bufs[0].base = (char*) data->buf;
  bufs[0].len = data->len;
  
  int res;
  
  data->isolate = isolate;
  data->ctx = v8::Global<v8::Context>(isolate, isolate->GetCurrentContext());
  data->cb = v8::Global<v8::Function>(isolate, hdl);
  
  uv_handle_set_data((uv_handle_t*) send_req, data);
  
  res = uv__udp_send(send_req, &obj->udp_handle, bufs, sizeof(bufs) / sizeof(bufs[0]), (struct sockaddr*) &dst_addr, sizeof(dst_addr), NetlinkSocket::onSent);
  if(res < 0) {
    isolate->ThrowException(v8::Exception::Error(v8::String::NewFromUtf8(isolate, "failed to send packet")));
    return;
  }
}

void NetlinkSocket::Close(const v8::FunctionCallbackInfo<v8::Value>& args) {
  NetlinkSocket* obj = ObjectWrap::Unwrap<NetlinkSocket>(args.Holder());
  
  uv_udp_recv_stop(&obj->udp_handle);

  close(obj->fd);
  obj->fd = -1;
}

NODE_MODULE(netlink, NetlinkSocket::Init)
